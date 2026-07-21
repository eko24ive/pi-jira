/** Issue, comment, and search operations built on top of the Jira client. */
import { jiraJson } from "./client.js";
import { compactIssue } from "./format.js";
import { DEFAULT_SEARCH_FIELDS, SEARCH_BLOCKED_FIELDS, type CompactIssue, type JiraComment, type JiraIssue, type JiraWorkspace } from "./types.js";

/** Dedupe non-empty strings while preserving order. */
export function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

/** Merge default and requested Jira field lists without adding policy fields. */
export function mergeFields(defaultFields: readonly string[], extraFields?: string[]): string[] {
	return uniqueStrings([...defaultFields, ...(extraFields ?? [])]);
}

function validateSearchFields(fields: string[]): void {
	const blocked = fields.filter((field) => {
		const lower = field.toLowerCase();
		return SEARCH_BLOCKED_FIELDS.has(lower) || lower.startsWith("*");
	});
	if (blocked.length > 0) {
		throw new Error(`jira_search does not return ${blocked.join(", ")} fields; use jira_get_issue or jira_get_comments instead.`);
	}
}

/** Fetch one Jira issue with the exact fields/expands requested by the caller. */
export async function fetchIssue(workspace: JiraWorkspace, issueKey: string, fields: string[], expand?: string[], signal?: AbortSignal): Promise<JiraIssue> {
	const query: Record<string, string | undefined> = { fields: uniqueStrings(fields).join(",") };
	if (expand && expand.length > 0) query.expand = uniqueStrings(expand).join(",");
	return jiraJson<JiraIssue>(workspace, "GET", `/issue/${encodeURIComponent(issueKey)}`, { query, signal });
}

/** Fetch every Jira comment page for one issue. */
export async function fetchAllComments(workspace: JiraWorkspace, issueKey: string, signal?: AbortSignal): Promise<JiraComment[]> {
	const comments: JiraComment[] = [];
	let startAt = 0;
	let total = Number.POSITIVE_INFINITY;
	while (comments.length < total) {
		const page = await jiraJson<Record<string, unknown>>(workspace, "GET", `/issue/${encodeURIComponent(issueKey)}/comment`, {
			query: { startAt, maxResults: 100 },
			signal,
		});
		const pageComments = Array.isArray(page?.comments) ? (page.comments as JiraComment[]) : [];
		comments.push(...pageComments);
		total = typeof page?.total === "number" ? page.total : comments.length;
		if (pageComments.length === 0) break;
		startAt += typeof page?.maxResults === "number" ? page.maxResults : pageComments.length;
	}
	return comments;
}

export type SearchIssuesParams = {
	jql?: string;
	maxResults?: number;
	fields?: string[];
	nextPageToken?: string;
};

export type SearchIssuesResult = {
	text: string;
	details: {
		issues: CompactIssue[];
		nextPageToken?: unknown;
		rawResponse: Record<string, unknown>;
	};
};

/** Run explicit JQL search and format the compact issue list returned to the model. */
export async function searchIssues(workspace: JiraWorkspace, params: SearchIssuesParams, signal?: AbortSignal): Promise<SearchIssuesResult> {
	const jql = params.jql?.trim();
	if (!jql) throw new Error("jira_search requires jql.");
	const fields = mergeFields(DEFAULT_SEARCH_FIELDS, params.fields);
	validateSearchFields(fields);
	const response = await jiraJson<Record<string, unknown>>(workspace, "POST", "/search/jql", {
		body: {
			jql,
			maxResults: params.maxResults ?? 50,
			fields,
			...(params.nextPageToken ? { nextPageToken: params.nextPageToken } : {}),
		},
		signal,
	});
	const rawIssues = Array.isArray(response?.issues) ? (response.issues as JiraIssue[]) : [];
	const issues = rawIssues.map(compactIssue);
	return {
		text: [
			`Found ${issues.length} Jira issue(s) for ${workspace.siteUrl}.`,
			"",
			...issues.map((issue) =>
				[
					issue.key,
					issue.status ? `[${issue.status}]` : undefined,
					issue.type ? `(${issue.type})` : undefined,
					issue.assignee ? `@${issue.assignee}` : undefined,
					"—",
					issue.summary,
				]
					.filter(Boolean)
					.join(" "),
			),
		].join("\n"),
		details: {
			issues,
			nextPageToken: response?.nextPageToken,
			rawResponse: { ...response, issues: rawIssues },
		},
	};
}
