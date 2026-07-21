/**
 * Jira issue creation helpers.
 *
 * Jira create screens are project/type specific, so the tool surface exposes
 * Jira's raw create payload while providing two small conveniences: metadata
 * inspection and string-description to ADF conversion.
 */
import { textToAdf } from "./adf.js";
import { jiraJson } from "./client.js";
import { browseUrl } from "./format.js";
import type { JiraWorkspace, TextOutput } from "./types.js";

export type JiraPayload = Record<string, unknown>;

export type CreateMetaParams = {
	projectKeys?: string[];
	projectIds?: string[];
	issueTypeIds?: string[];
	issueTypeNames?: string[];
	expand?: string[];
};

export type CreateIssueParams = {
	fields: JiraPayload;
	update?: JiraPayload;
	properties?: unknown[];
	historyMetadata?: JiraPayload;
	transition?: JiraPayload;
};

type CreateMetaField = { name?: string; required?: boolean };
type CreateMetaIssueType = { id?: string; name?: string; fields?: Record<string, CreateMetaField> };
type CreateMetaProject = { id?: string; key?: string; name?: string; issuetypes?: CreateMetaIssueType[] };
type JiraCreatedIssue = { id?: string; key?: string; self?: string };

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function commaList(values: string[] | undefined): string | undefined {
	const list = uniqueStrings(values ?? []);
	return list.length > 0 ? list.join(",") : undefined;
}

function isRecord(value: unknown): value is JiraPayload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createMetaQuery(params: CreateMetaParams): Record<string, string | undefined> {
	return {
		projectKeys: commaList(params.projectKeys),
		projectIds: commaList(params.projectIds),
		issuetypeIds: commaList(params.issueTypeIds),
		issuetypeNames: commaList(params.issueTypeNames),
		expand: params.expand?.length ? commaList(params.expand) : "projects.issuetypes.fields",
	};
}

function summarizeCreateMeta(response: Record<string, unknown>): string {
	const projects = Array.isArray(response.projects) ? (response.projects as CreateMetaProject[]) : [];
	const lines = [`Create metadata projects: ${projects.length}`];
	for (const project of projects) {
		lines.push("", `${project.key ?? project.id ?? "unknown"} — ${project.name ?? ""}`);
		for (const issueType of project.issuetypes ?? []) {
			const required = Object.entries(issueType.fields ?? {})
				.filter(([, field]) => field.required)
				.map(([key, field]) => `${key}${field.name ? ` (${field.name})` : ""}`);
			lines.push(`- ${issueType.id ?? "?"}: ${issueType.name ?? ""}; required: ${required.join(", ") || "none"}`);
		}
	}
	return lines.join("\n");
}

function normalizeCreateFields(fields: JiraPayload): JiraPayload {
	if (!isRecord(fields)) throw new Error("jira_create_issue requires fields to be an object.");
	const normalized = { ...fields };
	if (Object.keys(normalized).length === 0) throw new Error("jira_create_issue requires at least one create field.");
	if (typeof normalized.description === "string") normalized.description = textToAdf(normalized.description);
	return normalized;
}

function createIssueBody(params: CreateIssueParams): Record<string, unknown> {
	return {
		fields: normalizeCreateFields(params.fields),
		...(params.update !== undefined ? { update: params.update } : {}),
		...(params.properties !== undefined ? { properties: params.properties } : {}),
		...(params.historyMetadata !== undefined ? { historyMetadata: params.historyMetadata } : {}),
		...(params.transition !== undefined ? { transition: params.transition } : {}),
	};
}

/** Fetch Jira's project/type-specific create fields and return a compact required-field summary. */
export async function getCreateMetadata(workspace: JiraWorkspace, params: CreateMetaParams, signal?: AbortSignal): Promise<TextOutput> {
	const createmeta = await jiraJson<Record<string, unknown>>(workspace, "GET", "/issue/createmeta", { query: createMetaQuery(params), signal });
	return { text: summarizeCreateMeta(createmeta), details: { createmeta } };
}

/** Create one Jira issue using Jira's raw create payload shape. */
export async function createIssue(workspace: JiraWorkspace, params: CreateIssueParams, signal?: AbortSignal): Promise<TextOutput> {
	const body = createIssueBody(params);
	const created = await jiraJson<JiraCreatedIssue>(workspace, "POST", "/issue", { body, signal });
	const issueKey = created.key ?? created.id ?? "unknown";
	const issueUrl = created.key ? browseUrl(workspace, created.key) : created.self;
	return {
		text: `Created Jira issue ${issueKey}${issueUrl ? `\nURL: ${issueUrl}` : ""}`,
		details: { created, body },
	};
}
