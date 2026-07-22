/** Jira Cloud REST client helpers. No generic Jira request tool is exposed. */
import { randomUUID } from "node:crypto";
import { createWriteStream, openAsBlob } from "node:fs";
import { access, link, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { JiraAttachmentDto, JiraWorkspace } from "./types.js";

const BUN_UPLOAD_LIMIT = 100 * 1024 ** 2;
const MIME_TYPES: Record<string, string> = {
	".3g2": "video/3gpp2",
	".3gp": "video/3gpp",
	".avi": "video/x-msvideo",
	".flv": "video/x-flv",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".m2v": "video/mpeg",
	".m4v": "video/mp4",
	".mkv": "video/x-matroska",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".mpeg": "video/mpeg",
	".mpg": "video/mpeg",
	".ogv": "video/ogg",
	".png": "image/png",
	".ts": "video/mp2t",
	".webm": "video/webm",
	".wmv": "video/x-ms-wmv",
};

type JiraRequestOptions = {
	method: string;
	query?: Record<string, string | number | boolean | undefined>;
	headers?: Record<string, string>;
	body?: BodyInit;
	signal?: AbortSignal;
};

export type JiraDownloadRequest = {
	apiPath: string;
	outputPath: string;
};

function authHeader(workspace: JiraWorkspace): string {
	return `Basic ${Buffer.from(`${workspace.email}:${workspace.apiToken}`, "utf8").toString("base64")}`;
}

function apiUrl(workspace: JiraWorkspace, apiPath: string, query?: JiraRequestOptions["query"]): URL {
	const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
	const url = new URL(`${workspace.siteUrl}/rest/api/3${path}`);
	for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
	return url;
}

function formatJiraErrorBody(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	try {
		const parsed = JSON.parse(trimmed);
		const parts: string[] = [];
		if (Array.isArray(parsed.errorMessages)) parts.push(...parsed.errorMessages.map(String));
		if (parsed.errors && typeof parsed.errors === "object") {
			for (const [field, message] of Object.entries(parsed.errors)) parts.push(`${field}: ${String(message)}`);
		}
		return parts.length ? parts.join("; ") : JSON.stringify(parsed);
	} catch {
		return trimmed.slice(0, 2000);
	}
}

async function jiraRequest(workspace: JiraWorkspace, apiPath: string, options: JiraRequestOptions): Promise<Response> {
	const response = await fetch(apiUrl(workspace, apiPath, options.query), {
		method: options.method,
		headers: { Accept: "application/json", Authorization: authHeader(workspace), ...options.headers },
		body: options.body,
		signal: options.signal,
	});
	if (response.ok) return response;

	const retryAfter = response.status === 429 ? response.headers.get("retry-after") : undefined;
	const bodyText = formatJiraErrorBody(await response.text());
	throw new Error(
		`Jira ${options.method} ${apiPath} failed: ${response.status} ${response.statusText}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}${bodyText ? `: ${bodyText}` : ""}`,
	);
}

/** Call a Jira REST API v3 JSON endpoint. */
export async function jiraJson(
	workspace: JiraWorkspace,
	method: string,
	apiPath: string,
	options: { body?: unknown; query?: JiraRequestOptions["query"]; signal?: AbortSignal } = {},
): Promise<unknown> {
	const response = await jiraRequest(workspace, apiPath, {
		method,
		query: options.query,
		signal: options.signal,
		...(options.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	if (response.status === 204 || !text.trim()) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Jira ${method} ${apiPath} returned invalid JSON.`);
	}
}

/** Upload explicit local files through Jira's documented multipart endpoint. */
export async function jiraUploadAttachments(
	workspace: JiraWorkspace,
	issueKey: string,
	filePaths: string[],
	signal?: AbortSignal,
): Promise<JiraAttachmentDto[]> {
	if (!filePaths.length) throw new Error("Jira attachment upload requires at least one file path.");
	const files = await Promise.all(
		filePaths.map(async (filePath) => {
			const info = await stat(filePath);
			if (!info.isFile()) throw new Error(`Jira attachment path is not a file: ${filePath}`);
			const inferredType = MIME_TYPES[extname(filePath).toLowerCase()];
			const source = inferredType ? await openAsBlob(filePath, { type: inferredType }) : await openAsBlob(filePath);
			return { filePath, size: info.size, source };
		}),
	);
	if (process.versions.bun && files.reduce((total, file) => total + file.size, 0) > BUN_UPLOAD_LIMIT) {
		throw new Error("Bun attachment uploads are limited to 100 MiB because its FormData implementation requires buffering.");
	}

	const body = new FormData();
	for (const { filePath, source } of files) {
		// Bun ignores FormData's filename argument for FileRef and leaks the absolute path.
		const blob = process.versions.bun ? new Blob([await source.arrayBuffer()], { type: source.type }) : source;
		body.append("file", new File([blob], basename(filePath), { type: blob.type }));
	}

	const apiPath = `/issue/${encodeURIComponent(issueKey)}/attachments`;
	const response = await jiraRequest(workspace, apiPath, {
		method: "POST",
		headers: { "X-Atlassian-Token": "no-check" },
		body,
		signal,
	});
	try {
		const attachments: unknown = JSON.parse(await response.text());
		if (!Array.isArray(attachments) || attachments.length !== files.length) throw new Error("response does not match uploaded files");
		for (const attachment of attachments) {
			if (
				!attachment ||
				typeof attachment !== "object" ||
				(typeof (attachment as JiraAttachmentDto).id !== "string" && typeof (attachment as JiraAttachmentDto).id !== "number") ||
				typeof (attachment as JiraAttachmentDto).filename !== "string"
			)
				throw new Error("response contains invalid attachment metadata");
		}
		return attachments as JiraAttachmentDto[];
	} catch (error) {
		throw new Error(`Jira POST ${apiPath} returned an invalid attachment response: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function downloadFile(workspace: JiraWorkspace, request: JiraDownloadRequest, signal?: AbortSignal): Promise<void> {
	await withFileMutationQueue(request.outputPath, async () => {
		const directory = dirname(request.outputPath);
		await mkdir(directory, { recursive: true });
		try {
			await access(request.outputPath);
			throw new Error(`Refusing to overwrite existing attachment: ${request.outputPath}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const response = await jiraRequest(workspace, request.apiPath, { method: "GET", signal });
		const temporaryPath = join(directory, `.${basename(request.outputPath)}.${randomUUID()}.tmp`);
		try {
			if (response.body) await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(temporaryPath, { flags: "wx" }));
			else await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
			await link(temporaryPath, request.outputPath);
			await rm(temporaryPath);
		} catch (error) {
			await rm(temporaryPath, { force: true });
			throw error;
		}
	});
}

/** Download a set atomically per file and roll back files created by a failed batch. */
export async function jiraDownloadFiles(workspace: JiraWorkspace, requests: JiraDownloadRequest[], signal?: AbortSignal): Promise<void> {
	const completed: string[] = [];
	try {
		for (const request of requests) {
			await downloadFile(workspace, request, signal);
			completed.push(request.outputPath);
		}
	} catch (error) {
		for (const path of completed) await withFileMutationQueue(path, () => rm(path, { force: true }));
		throw error;
	}
}
