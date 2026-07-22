/**
 * Human-readable Jira formatting.
 *
 * Tool responses stay compact, while export Markdown is intentionally simple and
 * attachment-safe: metadata only, never attachment bodies.
 */
import { adfToText } from "./adf.js";
import type { CompactIssue, JiraAttachmentDto, JiraComment, JiraIssue, JiraNamed, JiraTransition, JiraUser, JiraWorkspace } from "./types.js";

/** Return the most useful stable display name Jira exposed for a user. */
export function displayName(user: JiraUser | null | undefined): string {
	if (!user) return "Unassigned";
	return user.displayName || user.name || user.emailAddress || user.accountId || "Unknown";
}

function fieldName(value: JiraNamed | null | undefined): string {
	return value?.name || value?.value || value?.key || "";
}

function formatList(values: unknown[] | undefined): string {
	if (!Array.isArray(values) || values.length === 0) return "";
	return values
		.map((value) => {
			if (typeof value === "string") return value;
			if (value && typeof value === "object") return fieldName(value as JiraNamed);
			return "";
		})
		.filter(Boolean)
		.join(", ");
}

/** Build the browser URL for an issue on the mapped Jira site. */
export function browseUrl(workspace: JiraWorkspace, issueKey: string): string {
	return `${workspace.siteUrl}/browse/${encodeURIComponent(issueKey)}`;
}

/** Extract attachment metadata without downloading attachment bodies. */
export function attachmentMetadata(issue: JiraIssue): Array<JiraAttachmentDto & { id: string }> {
	const attachments = issue.fields?.attachment;
	if (!Array.isArray(attachments)) return [];
	return attachments.filter((attachment) => attachment.id !== undefined).map((attachment) => ({ ...attachment, id: String(attachment.id) }));
}

const DISPLAYED_SEARCH_FIELDS = new Set(["summary", "status", "issuetype", "priority", "assignee", "parent", "updated"]);

function compactFieldValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map(compactFieldValue);
	if (!value || typeof value !== "object") return String(value);
	const record = value as Record<string, unknown>;
	return record.displayName ?? record.name ?? record.value ?? record.key ?? record.id ?? "[object]";
}

/** Convert a raw Jira issue into the compact shape returned by `jira_search`. */
export function compactIssue(workspace: JiraWorkspace, issue: JiraIssue, requestedFields: string[] = []): CompactIssue {
	const fields = issue.fields ?? {};
	const requestedEntries = requestedFields
		.filter((field) => !DISPLAYED_SEARCH_FIELDS.has(field.toLowerCase()) && fields[field] !== undefined)
		.map((field) => [field, compactFieldValue(fields[field])]);
	return {
		key: issue.key,
		url: browseUrl(workspace, issue.key),
		summary: fields.summary ?? "",
		status: fieldName(fields.status) || undefined,
		type: fieldName(fields.issuetype) || undefined,
		priority: fieldName(fields.priority) || undefined,
		assignee: fields.assignee ? displayName(fields.assignee) : undefined,
		parentKey: fields.parent?.key,
		updated: fields.updated,
		requestedFields: requestedEntries.length ? Object.fromEntries(requestedEntries) : undefined,
	};
}

function linkLines(issue: JiraIssue): string[] {
	const links = issue.fields?.issuelinks;
	if (!Array.isArray(links)) return [];
	return links
		.map((link) => {
			if (link.outwardIssue?.key) return `${link.type?.outward || link.type?.name || "links to"} ${link.outwardIssue.key}`;
			if (link.inwardIssue?.key) return `${link.type?.inward || link.type?.name || "linked from"} ${link.inwardIssue.key}`;
			return undefined;
		})
		.filter(Boolean) as string[];
}

function mdCell(value: unknown): string {
	return String(value ?? "")
		.replace(/\|/g, "\\|")
		.replace(/\n/g, " ");
}

/** Render one issue into the readable Markdown file used by exports. */
export function issueMarkdown(issue: JiraIssue): string {
	const fields = issue.fields ?? {};
	const attachments = attachmentMetadata(issue);
	const lines = [
		`# ${issue.key} — ${fields.summary ?? ""}`,
		"",
		`- Type: ${fieldName(fields.issuetype) || ""}`,
		`- Status: ${fieldName(fields.status) || ""}`,
		`- Priority: ${fieldName(fields.priority) || ""}`,
		`- Assignee: ${fields.assignee ? displayName(fields.assignee) : "Unassigned"}`,
		`- Reporter: ${fields.reporter ? displayName(fields.reporter) : ""}`,
		`- Created: ${fields.created ?? ""}`,
		`- Updated: ${fields.updated ?? ""}`,
		`- Labels: ${formatList(fields.labels)}`,
		`- Components: ${formatList(fields.components)}`,
		`- Fix Versions: ${formatList(fields.fixVersions)}`,
		"",
		"## Description",
		"",
		adfToText(fields.description) || "_(No description)_",
		"",
		"## Links",
		"",
	];

	const links = linkLines(issue);
	lines.push(...(links.length > 0 ? links.map((line) => `- ${line}`) : ["_(No links)_"]));
	lines.push("", "## Attachments", "");
	if (attachments.length === 0) {
		lines.push("_(No attachments)_");
	} else {
		lines.push("| id | filename | size | mime |", "| --- | --- | ---: | --- |");
		for (const attachment of attachments) {
			lines.push(`| ${mdCell(attachment.id)} | ${mdCell(attachment.filename)} | ${mdCell(attachment.size)} | ${mdCell(attachment.mimeType)} |`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

/** Render one issue into compact model-visible text. */
export function issueSummaryText(workspace: JiraWorkspace, issue: JiraIssue): string {
	const fields = issue.fields ?? {};
	const attachments = attachmentMetadata(issue);
	return [
		`${issue.key} — ${fields.summary ?? ""}`,
		`URL: ${browseUrl(workspace, issue.key)}`,
		`Type: ${fieldName(fields.issuetype) || ""}`,
		`Status: ${fieldName(fields.status) || ""}`,
		`Priority: ${fieldName(fields.priority) || ""}`,
		`Assignee: ${fields.assignee ? displayName(fields.assignee) : "Unassigned"}`,
		`Reporter: ${fields.reporter ? displayName(fields.reporter) : ""}`,
		`Created: ${fields.created ?? ""}`,
		`Updated: ${fields.updated ?? ""}`,
		`Labels: ${formatList(fields.labels)}`,
		`Components: ${formatList(fields.components)}`,
		"",
		"Description:",
		adfToText(fields.description) || "(No description)",
		"",
		`Attachments: ${attachments.length}`,
		...attachments.map(
			(attachment) => `- ${attachment.id}: ${attachment.filename ?? ""} (${attachment.size ?? "?"} bytes, ${attachment.mimeType ?? "unknown"})`,
		),
	].join("\n");
}

/** Render comments into the readable Markdown file used by exports. */
export function commentsMarkdown(issueKey: string, comments: JiraComment[]): string {
	const lines = [`# Comments for ${issueKey}`, ""];
	if (comments.length === 0) {
		lines.push("_(No comments)_", "");
		return lines.join("\n");
	}
	for (const comment of comments) {
		lines.push(`## Comment ${comment.id} — ${displayName(comment.author)} — ${comment.created ?? ""}`, "", adfToText(comment.body) || "_(No text)_", "");
	}
	return lines.join("\n");
}

/** Render comments into compact model-visible text. */
export function commentsSummaryText(issueKey: string, comments: JiraComment[]): string {
	const lines = [`Comments for ${issueKey}: ${comments.length}`];
	for (const comment of comments) {
		lines.push("", `${comment.id} — ${displayName(comment.author)} — ${comment.created ?? ""}`);
		if (comment.updated && comment.updated !== comment.created) lines.push(`Updated: ${comment.updated}`);
		lines.push(adfToText(comment.body) || "(No text)");
	}
	return lines.join("\n");
}

/** Render transition IDs and target statuses for quick selection. */
export function transitionSummary(transitions: JiraTransition[]): string {
	if (transitions.length === 0) return "No transitions available.";
	return transitions.map((transition) => `${transition.id}: ${transition.name}${transition.to?.name ? ` -> ${transition.to.name}` : ""}`).join("\n");
}
