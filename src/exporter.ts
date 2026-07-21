/**
 * Jira export filesystem helpers.
 *
 * Exports are append-only run directories. This module writes issue/comment text
 * and attachment metadata, but never attachment bodies.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { attachmentMetadata, commentsMarkdown, issueMarkdown } from "./format.js";
import { fetchAllComments, fetchIssue } from "./issues.js";
import { DEFAULT_ISSUE_FIELDS, type ExportedIssuePaths, type JiraWorkspace } from "./types.js";

/** Generate a short collision-avoidance suffix for export paths. */
export function randomSuffix(bytes = 3): string {
	return randomBytes(bytes).toString("hex");
}

/** Timestamp format safe for directory names and stable enough for human sorting. */
export function timestampForPath(date = new Date()): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

/** Remove path separators/control characters from Jira-provided filenames. */
export function safeFileName(name: string, fallback: string): string {
	const sanitized = name.replace(/[\\/\0\x00-\x1F\x7F]/g, "-").trim();
	if (!sanitized || sanitized === "." || sanitized === "..") return fallback;
	return sanitized;
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	});
}

async function writeTextFile(path: string, data: string): Promise<void> {
	await withFileMutationQueue(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, data, "utf8");
	});
}

/** Create one timestamped export run directory under the chosen base directory. */
export async function createRunDirectory(baseDir: string): Promise<string> {
	const runDir = join(baseDir, `${timestampForPath()}-${randomSuffix()}`);
	await mkdir(runDir, { recursive: true });
	return runDir;
}

/** Write all files for one issue inside an existing export run directory. */
export async function exportIssueIntoRun(workspace: JiraWorkspace, issueKey: string, runDir: string, signal?: AbortSignal): Promise<ExportedIssuePaths> {
	const issue = await fetchIssue(workspace, issueKey, DEFAULT_ISSUE_FIELDS, undefined, signal);
	const comments = await fetchAllComments(workspace, issue.key, signal);
	const issueDir = join(runDir, safeFileName(issue.key, "issue"));
	const attachmentsDir = join(issueDir, "attachments");
	await mkdir(attachmentsDir, { recursive: true });

	const paths: ExportedIssuePaths = {
		issueKey: issue.key,
		directory: issueDir,
		issueJson: join(issueDir, "issue.json"),
		issueMarkdown: join(issueDir, "issue.md"),
		commentsJson: join(issueDir, "comments.json"),
		commentsMarkdown: join(issueDir, "comments.md"),
		attachmentsJson: join(issueDir, "attachments.json"),
		attachmentsDirectory: attachmentsDir,
	};

	await writeJsonFile(paths.issueJson, issue);
	await writeTextFile(paths.issueMarkdown, issueMarkdown(issue));
	await writeJsonFile(paths.commentsJson, comments);
	await writeTextFile(paths.commentsMarkdown, commentsMarkdown(issue.key, comments));
	await writeJsonFile(paths.attachmentsJson, attachmentMetadata(issue));

	return paths;
}

/** Write an export manifest through the shared file mutation queue. */
export async function writeManifest(path: string, manifest: unknown): Promise<void> {
	await writeJsonFile(path, manifest);
}

async function saveFullToolOutput(workspace: JiraWorkspace, text: string): Promise<string> {
	const file = join(workspace.exportBaseDir, "tool-output", `${timestampForPath()}-${randomSuffix()}.txt`);
	await writeTextFile(file, text);
	return file;
}

/** Build bounded Pi tool output, saving the full text under the export dir if truncated. */
export async function textResult(workspace: JiraWorkspace, text: string, details: Record<string, unknown> = {}) {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { content: [{ type: "text" as const, text }], details };

	const fullOutputPath = await saveFullToolOutput(workspace, text);
	const resultText = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
	return { content: [{ type: "text" as const, text: resultText }], details: { ...details, truncation, fullOutputPath } };
}
