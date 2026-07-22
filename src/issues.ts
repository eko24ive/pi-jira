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
	if (blocked.length > 0)
		throw new Error(`jira_search does not return ${blocked.join(", ")} fields; use jira_get_issue, jira_get_issues, or jira_get_comments instead.`);
}

function requireRecord(value: unknown, operation: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${operation} returned an invalid object response.`);
	return value as Record<string, unknown>;
}

function requireIssue(value: unknown, operation: string): JiraIssue {
	if (!value || typeof value !== "object" || typeof (value as JiraIssue).key !== "string") throw new Error(`${operation} returned an invalid issue response.`);
	return value as JiraIssue;
}

function pageSize(value: number | undefined, fallback: number): number {
	const size = value ?? fallback;
	if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error("Jira search maxResults must be an integer from 1 to 100.");
	return size;
}

/** Fetch one Jira issue with the exact fields/expands requested by the caller. */
export async function fetchIssue(workspace: JiraWorkspace, issueKey: string, fields: string[], expand?: string[], signal?: AbortSignal): Promise<JiraIssue> {
	const query: Record<string, string | undefined> = { fields: uniqueStrings(fields).join(",") };
	if (expand && expand.length > 0) query.expand = uniqueStrings(expand).join(",");
	const issue = await jiraJson(workspace, "GET", `/issue/${encodeURIComponent(issueKey)}`, { query, signal });
	return requireIssue(issue, `Jira issue ${issueKey}`);
}

export type BulkIssueResult = {
	issues: JiraIssue[];
	issueErrors: unknown[];
};

/** Fetch up to 100 explicit Jira issues in one request. */
export async function fetchIssues(
	workspace: JiraWorkspace,
	issueIdsOrKeys: string[],
	fields: string[],
	expand?: string[],
	signal?: AbortSignal,
): Promise<BulkIssueResult> {
	const keys = uniqueStrings(issueIdsOrKeys);
	if (keys.length === 0 || keys.length > 100) throw new Error("jira_get_issues requires between 1 and 100 issue ids or keys.");
	const response = requireRecord(
		await jiraJson(workspace, "POST", "/issue/bulkfetch", {
			body: {
				issueIdsOrKeys: keys,
				fields: uniqueStrings(fields),
				...(expand?.length ? { expand: uniqueStrings(expand) } : {}),
			},
			signal,
		}),
		"Jira bulk issue fetch",
	);
	if (!Array.isArray(response?.issues)) throw new Error("Jira bulk issue fetch returned an invalid issues response.");
	const issues = response.issues.map((issue, index) => requireIssue(issue, `Jira bulk issue fetch item ${index}`));
	const issueErrors = response.issueErrors === undefined ? [] : response.issueErrors;
	if (!Array.isArray(issueErrors)) throw new Error("Jira bulk issue fetch returned invalid issueErrors.");
	return { issues, issueErrors };
}

/** Fetch every Jira comment page for one issue without silently accepting malformed or incomplete pages. */
export async function fetchAllComments(workspace: JiraWorkspace, issueKey: string, signal?: AbortSignal): Promise<JiraComment[]> {
	const comments: JiraComment[] = [];
	let startAt = 0;
	let total = Number.POSITIVE_INFINITY;
	while (comments.length < total) {
		const page = requireRecord(
			await jiraJson(workspace, "GET", `/issue/${encodeURIComponent(issueKey)}/comment`, {
				query: { startAt, maxResults: 100 },
				signal,
			}),
			`Jira comments for ${issueKey}`,
		);
		if (!Array.isArray(page?.comments) || typeof page.startAt !== "number" || typeof page.maxResults !== "number" || typeof page.total !== "number") {
			throw new Error(`Jira comments for ${issueKey} returned an invalid page.`);
		}
		if (
			!Number.isInteger(page.startAt) ||
			!Number.isInteger(page.maxResults) ||
			!Number.isInteger(page.total) ||
			page.startAt !== startAt ||
			page.total < 0 ||
			page.maxResults < 0
		)
			throw new Error(`Jira comments for ${issueKey} returned inconsistent pagination.`);
		const pageComments = page.comments as JiraComment[];
		if (pageComments.length > page.maxResults || page.startAt + pageComments.length > page.total)
			throw new Error(`Jira comments for ${issueKey} returned inconsistent page bounds.`);
		total = page.total;
		if (pageComments.length === 0) {
			if (comments.length < total) throw new Error(`Jira comments for ${issueKey} ended before all ${total} comments were returned.`);
			break;
		}
		comments.push(...pageComments);
		startAt += pageComments.length;
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
	details: { issues: CompactIssue[]; nextPageToken?: string };
};

type SearchPage = { issues: JiraIssue[]; nextPageToken?: string };

async function fetchSearchPage(
	workspace: JiraWorkspace,
	params: { jql: string; maxResults: number; fields: string[]; nextPageToken?: string },
	signal?: AbortSignal,
): Promise<SearchPage> {
	const response = requireRecord(
		await jiraJson(workspace, "POST", "/search/jql", {
			body: { ...params, ...(params.nextPageToken ? { nextPageToken: params.nextPageToken } : {}) },
			signal,
		}),
		"Jira search",
	);
	if (!Array.isArray(response?.issues)) throw new Error("Jira search returned an invalid issues response.");
	const token = response.nextPageToken;
	if (token !== undefined && token !== null && typeof token !== "string") throw new Error("Jira search returned an invalid nextPageToken.");
	if (response.isLast !== undefined && typeof response.isLast !== "boolean") throw new Error("Jira search returned an invalid isLast value.");
	if (response.isLast === false && typeof token !== "string") throw new Error("Jira search returned isLast=false without a continuation token.");
	return {
		issues: response.issues.map((issue, index) => requireIssue(issue, `Jira search item ${index}`)),
		nextPageToken: response.isLast === true || typeof token !== "string" ? undefined : token,
	};
}

/** Run explicit JQL search and format one compact page for the model. */
export async function searchIssues(workspace: JiraWorkspace, params: SearchIssuesParams, signal?: AbortSignal): Promise<SearchIssuesResult> {
	const jql = params.jql?.trim();
	if (!jql) throw new Error("jira_search requires jql.");
	const fields = mergeFields(DEFAULT_SEARCH_FIELDS, params.fields);
	validateSearchFields(fields);
	const page = await fetchSearchPage(workspace, { jql, maxResults: pageSize(params.maxResults, 50), fields, nextPageToken: params.nextPageToken }, signal);
	const issues = page.issues.map((issue) => compactIssue(workspace, issue, params.fields));
	return {
		text: [
			`Found ${issues.length} Jira issue(s) for ${workspace.siteUrl}.`,
			"",
			...issues.map((issue) =>
				[
					`[${issue.key}](${issue.url})`,
					issue.status ? `[${issue.status}]` : undefined,
					issue.type ? `(${issue.type})` : undefined,
					issue.assignee ? `@${issue.assignee}` : undefined,
					issue.parentKey ? `parent:${issue.parentKey}` : undefined,
					issue.requestedFields ? `fields:${JSON.stringify(issue.requestedFields)}` : undefined,
					"—",
					issue.summary,
				]
					.filter(Boolean)
					.join(" "),
			),
		].join("\n"),
		details: { issues, nextPageToken: page.nextPageToken },
	};
}

/** Follow enhanced-search tokens without constructing model-facing output. */
export async function searchAllIssueKeys(workspace: JiraWorkspace, jql: string, maxResults = 50, signal?: AbortSignal): Promise<string[]> {
	if (!Number.isInteger(maxResults) || maxResults < 1) throw new Error("Jira export maxResults must be a positive integer.");
	const keys = new Set<string>();
	const seenTokens = new Set<string>();
	let nextPageToken: string | undefined;
	do {
		const page = await fetchSearchPage(workspace, { jql, maxResults: Math.min(100, maxResults - keys.size), fields: ["summary"], nextPageToken }, signal);
		for (const issue of page.issues) keys.add(issue.key);
		if (!page.issues.length && page.nextPageToken) throw new Error("Jira search returned an empty page with a continuation token.");
		nextPageToken = page.nextPageToken;
		if (nextPageToken) {
			if (seenTokens.has(nextPageToken)) throw new Error("Jira search repeated a continuation token.");
			seenTokens.add(nextPageToken);
		}
	} while (nextPageToken && keys.size < maxResults);
	return [...keys].slice(0, maxResults);
}
