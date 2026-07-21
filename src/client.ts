/**
 * Jira Cloud REST client helpers.
 *
 * These helpers are intentionally internal and named around the two operations
 * the extension needs: JSON API calls and binary attachment downloads. There is
 * no exposed generic `jira_request` tool.
 */
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { JiraWorkspace } from "./types.js";

function authHeader(workspace: JiraWorkspace): string {
	return `Basic ${Buffer.from(`${workspace.email}:${workspace.apiToken}`, "utf8").toString("base64")}`;
}

function apiUrl(workspace: JiraWorkspace, apiPath: string, query?: Record<string, string | number | boolean | undefined>): URL {
	const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
	const url = new URL(`${workspace.siteUrl}/rest/api/3${path}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
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
		if (parts.length > 0) return parts.join("; ");
		return JSON.stringify(parsed);
	} catch {
		return trimmed.slice(0, 2000);
	}
}

/** Call a Jira REST API v3 JSON endpoint and throw concise Jira-shaped errors on failure. */
export async function jiraJson<T = unknown>(
	workspace: JiraWorkspace,
	method: string,
	apiPath: string,
	options: {
		body?: unknown;
		query?: Record<string, string | number | boolean | undefined>;
		signal?: AbortSignal;
	} = {},
): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: authHeader(workspace),
	};
	let body: string | undefined;
	if (options.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(options.body);
	}

	const response = await fetch(apiUrl(workspace, apiPath, options.query), {
		method,
		headers,
		body,
		signal: options.signal,
	});
	const text = await response.text();
	if (!response.ok) {
		const retryAfter = response.status === 429 ? response.headers.get("retry-after") : undefined;
		const retryText = retryAfter ? ` (Retry-After: ${retryAfter})` : "";
		const bodyText = formatJiraErrorBody(text);
		throw new Error(`Jira ${method} ${apiPath} failed: ${response.status} ${response.statusText}${retryText}${bodyText ? `: ${bodyText}` : ""}`);
	}
	if (response.status === 204 || text.trim() === "") return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return text as T;
	}
}

/** Stream a Jira binary endpoint to disk through Pi's file mutation queue. */
export async function jiraDownload(workspace: JiraWorkspace, apiPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
	const response = await fetch(apiUrl(workspace, apiPath), {
		method: "GET",
		headers: {
			Accept: "application/octet-stream",
			Authorization: authHeader(workspace),
		},
		signal,
	});
	if (!response.ok) {
		const retryAfter = response.status === 429 ? response.headers.get("retry-after") : undefined;
		const retryText = retryAfter ? ` (Retry-After: ${retryAfter})` : "";
		const bodyText = formatJiraErrorBody(await response.text());
		throw new Error(`Jira GET ${apiPath} failed: ${response.status} ${response.statusText}${retryText}${bodyText ? `: ${bodyText}` : ""}`);
	}

	await withFileMutationQueue(outputPath, async () => {
		await mkdir(dirname(outputPath), { recursive: true });
		if (!response.body) {
			await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
			return;
		}
		await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(outputPath));
	});
}
