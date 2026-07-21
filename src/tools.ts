/**
 * Pi tool registration for the Jira extension.
 *
 * Tool descriptors keep Jira operations declarative while `registerJiraTool`
 * owns shared behavior: workspace resolution, model-visible output bounding, and
 * centralized write-tool approval wording.
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { adfToText, textToAdf } from "./adf.js";
import { jiraDownload, jiraJson } from "./client.js";
import { createIssue, getCreateMetadata, type CreateIssueParams, type CreateMetaParams } from "./create.js";
import { normalizeOutputDir, resolveWorkspace } from "./config.js";
import { createRunDirectory, exportIssueIntoRun, randomSuffix, safeFileName, textResult, timestampForPath, writeManifest } from "./exporter.js";
import { attachmentMetadata, browseUrl, commentsSummaryText, issueSummaryText, transitionSummary } from "./format.js";
import { fetchAllComments, fetchIssue, mergeFields, searchIssues, uniqueStrings, type SearchIssuesParams } from "./issues.js";
import {
	DEFAULT_ISSUE_FIELDS,
	type ExportedIssuePaths,
	type JiraComment,
	type JiraIssueLink,
	type JiraIssueRef,
	type JiraTransition,
	type JiraWorkspace,
	type TextOutput,
} from "./types.js";

type ToolSchema = ReturnType<typeof Type.Object>;
type JiraPayload = object;

type RunArgs<P> = {
	params: P;
	workspace: JiraWorkspace;
	signal?: AbortSignal;
	ctx: ExtensionContext;
};

/** Declarative definition for one Jira tool. */
type JiraToolSpec<P extends JiraPayload> = {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: string[];
	parameters: ToolSchema;
	mutates?: boolean;
	approvalHint?: string;
	run(args: RunArgs<P>): Promise<TextOutput>;
};

const COMMENT_FORMATTING_GUIDELINE =
	"For Jira comment bodies in jira_add_comment, jira_update_comment, and jira_link_issues, prefer Markdown-style links like [PR #2811](https://...) so they render as Jira links; bare https:// URLs are linkified too.";

const CREATE_ISSUE_GUIDELINE =
	"Use jira_get_createmeta before jira_create_issue when project, issue type, or required fields are unknown. For fields.description, pass plain text; jira_create_issue converts it to Jira ADF and linkifies Markdown-style links/bare URLs.";

const approvalLine = (toolName: string) =>
	`Before calling ${toolName}, get explicit user approval using existing mechanisms (ask_user if available, otherwise plaintext). This tool does not prompt by itself.`;

/** Attach the shared approval contract to mutating tool descriptions. */
function describeTool(spec: { name: string; description: string; mutates?: boolean; approvalHint?: string }): string {
	if (!spec.mutates) return spec.description;
	return `${spec.description} ${approvalLine(spec.name)}${spec.approvalHint ? ` ${spec.approvalHint}` : ""}`;
}

/** Register one Jira tool with shared workspace and output handling. */
function registerJiraTool<P extends JiraPayload>(pi: ExtensionAPI, spec: JiraToolSpec<P>): void {
	pi.registerTool({
		name: spec.name,
		label: spec.label,
		description: describeTool(spec),
		promptSnippet: spec.promptSnippet,
		promptGuidelines: spec.promptGuidelines,
		parameters: spec.parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const workspace = await resolveWorkspace(ctx.cwd);
			const output = await spec.run({ params: params as P, workspace, signal, ctx });
			return textResult(workspace, output.text, output.details ?? {});
		},
	});
}

type IssueKeyParams = { issueKey: string };
type IssueReadParams = IssueKeyParams & { fields?: string[]; expand?: string[] };
type ExportIssueParams = IssueKeyParams & { outputDir?: string };
type ExportIssuesParams = { issueKeys?: string[]; jql?: string; maxResults?: number; outputDir?: string };
type DownloadAttachmentParams = IssueKeyParams & { attachmentId: string; outputDir?: string };
type CommentBodyParams = IssueKeyParams & { body: string };
type CommentUpdateParams = CommentBodyParams & { commentId: string };
type CommentDeleteParams = IssueKeyParams & { commentId: string };
type EditIssueParams = IssueKeyParams & { fields?: JiraPayload; update?: JiraPayload; notifyUsers?: boolean };
type AssignIssueParams = IssueKeyParams & { accountId: string | null };
type TransitionListParams = IssueKeyParams & { expand?: string[] };
type TransitionIssueParams = IssueKeyParams & { transitionId: string; fields?: JiraPayload; update?: JiraPayload };
type LinkIssuesParams = { inwardIssueKey: string; outwardIssueKey: string; typeName?: string; typeId?: string; comment?: string };
type DeleteIssueLinkParams = { linkId: string };

/** Preserve each tool's parameter type while keeping the descriptor array simple. */
function defineJiraTool<P extends JiraPayload>(spec: JiraToolSpec<P>): JiraToolSpec<P> {
	return spec;
}

const toolSpecs = [
	defineJiraTool<SearchIssuesParams>({
		name: "jira_search",
		label: "Jira Search",
		description: "Search the mapped Jira Cloud workspace with explicit JQL. Search results do not include descriptions or comments.",
		promptSnippet: "Search mapped Jira issues using explicit JQL.",
		parameters: Type.Object({
			jql: Type.String({ description: "Required JQL query." }),
			maxResults: Type.Optional(Type.Number({ description: "Maximum results. Defaults to 50." })),
			fields: Type.Optional(Type.Array(Type.String({ description: "Additional Jira fields to fetch. description/comment are blocked here." }))),
			nextPageToken: Type.Optional(Type.String({ description: "Jira nextPageToken for manual pagination." })),
		}),
		run: ({ workspace, params, signal }) => searchIssues(workspace, params, signal),
	}),
	defineJiraTool<IssueReadParams>({
		name: "jira_get_issue",
		label: "Jira Issue",
		description: "Read one mapped Jira issue with compact text, raw JSON details, attachment metadata, and best-effort plain text description.",
		promptSnippet: "Read one Jira issue.",
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			fields: Type.Optional(Type.Array(Type.String({ description: "Additional Jira fields to fetch." }))),
			expand: Type.Optional(Type.Array(Type.String({ description: "Jira expand values." }))),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, mergeFields(DEFAULT_ISSUE_FIELDS, params.fields), params.expand, signal);
			return {
				text: issueSummaryText(workspace, issue),
				details: { issue, descriptionText: adfToText(issue.fields?.description), attachments: attachmentMetadata(issue) },
			};
		},
	}),
	defineJiraTool<IssueKeyParams>({
		name: "jira_get_comments",
		label: "Jira Comments",
		description: "Read all comments for one mapped Jira issue with compact text and raw comment JSON details.",
		promptSnippet: "Read comments for one Jira issue.",
		parameters: Type.Object({ issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }) }),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			const comments = await fetchAllComments(workspace, issue.key, signal);
			return {
				text: commentsSummaryText(issue.key, comments),
				details: { issueKey: issue.key, comments: comments.map((comment) => ({ ...comment, text: adfToText(comment.body) })) },
			};
		},
	}),
	defineJiraTool<ExportIssueParams>({
		name: "jira_export_issue",
		label: "Jira Export Issue",
		description: "Export one mapped Jira issue, comments, and attachment metadata to files. Attachment bodies are not downloaded.",
		promptSnippet: "Export one Jira issue and comments to JSON/Markdown files without downloading attachments.",
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			outputDir: Type.Optional(Type.String({ description: "Optional base directory for this export run." })),
		}),
		async run({ workspace, params, signal, ctx }) {
			const baseDir = params.outputDir ? normalizeOutputDir(params.outputDir, ctx.cwd) : workspace.exportBaseDir;
			const runDir = await createRunDirectory(baseDir);
			const issuePaths = await exportIssueIntoRun(workspace, params.issueKey, runDir, signal);
			const manifestPath = join(runDir, "manifest.json");
			await writeManifest(manifestPath, manifest(workspace, runDir, [issuePaths]));
			return {
				text: `Exported ${issuePaths.issueKey} to ${issuePaths.directory}\nManifest: ${manifestPath}`,
				details: { manifestPath, runDir, issues: [issuePaths] },
			};
		},
	}),
	defineJiraTool<ExportIssuesParams>({
		name: "jira_export_issues",
		label: "Jira Export Issues",
		description: "Batch export mapped Jira issues by issue keys or JQL. Attachment bodies are not downloaded.",
		promptSnippet: "Export multiple Jira issues by keys or JQL to JSON/Markdown files.",
		parameters: Type.Object({
			issueKeys: Type.Optional(Type.Array(Type.String({ description: "Issue keys to export." }))),
			jql: Type.Optional(Type.String({ description: "JQL query to search, then export returned issues." })),
			maxResults: Type.Optional(Type.Number({ description: "Maximum JQL results. Defaults to 50." })),
			outputDir: Type.Optional(Type.String({ description: "Optional base directory for this export run." })),
		}),
		async run({ workspace, params, signal, ctx }) {
			const hasKeys = Array.isArray(params.issueKeys) && params.issueKeys.length > 0;
			const hasJql = typeof params.jql === "string" && params.jql.length > 0;
			if (hasKeys === hasJql) throw new Error("jira_export_issues requires exactly one of issueKeys or jql.");

			let issueKeys: string[];
			if (hasJql) {
				const search = await searchIssues(workspace, { jql: params.jql, maxResults: params.maxResults, fields: ["project", "summary"] }, signal);
				issueKeys = search.details.issues.map((issue) => issue.key);
			} else {
				issueKeys = uniqueStrings(params.issueKeys ?? []);
			}

			const baseDir = params.outputDir ? normalizeOutputDir(params.outputDir, ctx.cwd) : workspace.exportBaseDir;
			const runDir = await createRunDirectory(baseDir);
			const issues: ExportedIssuePaths[] = [];
			for (const issueKey of issueKeys) issues.push(await exportIssueIntoRun(workspace, issueKey, runDir, signal));

			const manifestPath = join(runDir, "manifest.json");
			await writeManifest(manifestPath, manifest(workspace, runDir, issues));
			return { text: `Exported ${issues.length} Jira issue(s) to ${runDir}\nManifest: ${manifestPath}`, details: { manifestPath, runDir, issues } };
		},
	}),
	defineJiraTool<DownloadAttachmentParams>({
		name: "jira_download_attachment",
		label: "Jira Download Attachment",
		description: "Download one explicit Jira attachment after verifying the issue project and attachment membership. No size cap is applied.",
		promptSnippet: "Download an explicitly named Jira attachment by issue key and attachment id.",
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key that owns the attachment." }),
			attachmentId: Type.String({ description: "Jira attachment id." }),
			outputDir: Type.Optional(Type.String({ description: "Optional directory to write the attachment into." })),
		}),
		async run({ workspace, params, signal, ctx }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project", "attachment"], undefined, signal);
			const attachment = attachmentMetadata(issue).find((item) => item.id === String(params.attachmentId));
			if (!attachment) throw new Error(`Attachment ${params.attachmentId} is not listed on ${issue.key}.`);
			const outputDir = params.outputDir
				? normalizeOutputDir(params.outputDir, ctx.cwd)
				: join(workspace.exportBaseDir, `attachment-${timestampForPath()}-${randomSuffix()}`);
			const outputPath = join(outputDir, safeFileName(attachment.filename ?? "", `attachment-${params.attachmentId}`));
			await jiraDownload(workspace, `/attachment/content/${encodeURIComponent(params.attachmentId)}`, outputPath, signal);
			return {
				text: `Downloaded attachment ${params.attachmentId} from ${issue.key} to ${outputPath}`,
				details: { issueKey: issue.key, attachment, outputPath },
			};
		},
	}),
	defineJiraTool<CommentBodyParams>({
		name: "jira_add_comment",
		label: "Jira Add Comment",
		description: "Add a comment to a mapped Jira issue.",
		promptSnippet: "Add a Jira comment only after explicit user approval.",
		promptGuidelines: [COMMENT_FORMATTING_GUIDELINE],
		mutates: true,
		approvalHint: "Show issue key, site, and exact comment body before approval.",
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			body: Type.String({ description: "Comment body. Supports Markdown-style links [text](https://...) and bare URLs." }),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			const comment = await jiraJson<JiraComment>(workspace, "POST", `/issue/${encodeURIComponent(issue.key)}/comment`, {
				body: { body: textToAdf(params.body) },
				signal,
			});
			return {
				text: `Created comment ${comment.id} on ${issue.key}\nURL: ${browseUrl(workspace, issue.key)}\n\n${params.body}`,
				details: { issueKey: issue.key, comment, text: params.body },
			};
		},
	}),
	defineJiraTool<CommentUpdateParams>({
		name: "jira_update_comment",
		label: "Jira Update Comment",
		description: "Update an existing Jira comment.",
		promptSnippet: "Update a Jira comment only after explicit user approval.",
		promptGuidelines: [COMMENT_FORMATTING_GUIDELINE],
		mutates: true,
		approvalHint: "Show issue key, site, comment id, and exact new body before approval.",
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			commentId: Type.String({ description: "Jira comment id." }),
			body: Type.String({ description: "Replacement comment body. Supports Markdown-style links [text](https://...) and bare URLs." }),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			const comment = await jiraJson<JiraComment>(workspace, "PUT", `/issue/${encodeURIComponent(issue.key)}/comment/${encodeURIComponent(params.commentId)}`, {
				body: { body: textToAdf(params.body) },
				signal,
			});
			return { text: `Updated comment ${params.commentId} on ${issue.key}`, details: { issueKey: issue.key, comment, text: params.body } };
		},
	}),
	defineJiraTool<CommentDeleteParams>({
		name: "jira_delete_comment",
		label: "Jira Delete Comment",
		description: "Delete a Jira comment.",
		promptSnippet: "Delete a Jira comment only after explicit user approval.",
		mutates: true,
		approvalHint: "Show issue key, site, and comment id before approval.",
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			commentId: Type.String({ description: "Jira comment id." }),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			await jiraJson<void>(workspace, "DELETE", `/issue/${encodeURIComponent(issue.key)}/comment/${encodeURIComponent(params.commentId)}`, { signal });
			return { text: `Deleted comment ${params.commentId} on ${issue.key}`, details: { issueKey: issue.key, commentId: params.commentId, deleted: true } };
		},
	}),
	defineJiraTool<CreateMetaParams>({
		name: "jira_get_createmeta",
		label: "Jira Create Metadata",
		description: "Inspect Jira create-issue metadata for projects, issue types, and required fields.",
		promptSnippet: "Inspect Jira create metadata before creating issues when required fields are unknown.",
		promptGuidelines: [CREATE_ISSUE_GUIDELINE],
		parameters: Type.Object({
			projectKeys: Type.Optional(Type.Array(Type.String({ description: "Optional Jira project keys to filter metadata." }))),
			projectIds: Type.Optional(Type.Array(Type.String({ description: "Optional Jira project ids to filter metadata." }))),
			issueTypeIds: Type.Optional(Type.Array(Type.String({ description: "Optional Jira issue type ids to filter metadata." }))),
			issueTypeNames: Type.Optional(Type.Array(Type.String({ description: "Optional Jira issue type names to filter metadata." }))),
			expand: Type.Optional(Type.Array(Type.String({ description: "Create metadata expand values. Defaults to projects.issuetypes.fields." }))),
		}),
		run: ({ workspace, params, signal }) => getCreateMetadata(workspace, params, signal),
	}),
	defineJiraTool<CreateIssueParams>({
		name: "jira_create_issue",
		label: "Jira Create Issue",
		description: "Create a Jira issue with raw Jira fields/update payload. Prefer jira_get_createmeta first when required fields are unknown.",
		promptSnippet: "Create a Jira issue only after explicit user approval.",
		promptGuidelines: [CREATE_ISSUE_GUIDELINE],
		mutates: true,
		approvalHint: "Show site and exact create payload before approval.",
		parameters: Type.Object({
			fields: Type.Record(Type.String(), Type.Unknown(), {
				description: "Required Jira create fields, e.g. project, issuetype, summary. String description is converted to Jira ADF.",
			}),
			update: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional Jira update payload for create." })),
			properties: Type.Optional(Type.Array(Type.Unknown(), { description: "Optional Jira issue properties for create." })),
			historyMetadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional Jira history metadata." })),
			transition: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional Jira transition to apply on create when supported." })),
		}),
		run: ({ workspace, params, signal }) => createIssue(workspace, params, signal),
	}),
	defineJiraTool<IssueKeyParams>({
		name: "jira_get_editmeta",
		label: "Jira Edit Metadata",
		description: "Inspect editable fields for one mapped Jira issue before editing it.",
		promptSnippet: "Inspect Jira editable field metadata for one issue.",
		parameters: Type.Object({ issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }) }),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			const editmeta = await jiraJson<Record<string, unknown>>(workspace, "GET", `/issue/${encodeURIComponent(issue.key)}/editmeta`, { signal });
			const fields = Object.keys((editmeta.fields as Record<string, unknown> | undefined) ?? {});
			return { text: `Editable fields for ${issue.key}: ${fields.length}\n${fields.join("\n")}`, details: { issueKey: issue.key, editmeta } };
		},
	}),
	defineJiraTool<EditIssueParams>({
		name: "jira_edit_issue",
		label: "Jira Edit Issue",
		description: "Edit raw Jira issue fields/update payload for one mapped issue. Prefer jira_get_editmeta first for unknown fields.",
		promptSnippet: "Edit Jira issue fields/update payload only after explicit user approval.",
		mutates: true,
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			fields: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Jira fields payload." })),
			update: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Jira update payload." })),
			notifyUsers: Type.Optional(Type.Boolean({ description: "Whether Jira should notify users." })),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			if (params.fields === undefined && params.update === undefined) throw new Error("jira_edit_issue requires fields or update.");
			await jiraJson<void>(workspace, "PUT", `/issue/${encodeURIComponent(issue.key)}`, {
				query: params.notifyUsers === undefined ? undefined : { notifyUsers: params.notifyUsers },
				body: { ...(params.fields !== undefined ? { fields: params.fields } : {}), ...(params.update !== undefined ? { update: params.update } : {}) },
				signal,
			});
			return {
				text: `Edited issue ${issue.key}`,
				details: { issueKey: issue.key, fields: params.fields, update: params.update, notifyUsers: params.notifyUsers, success: true },
			};
		},
	}),
	defineJiraTool<AssignIssueParams>({
		name: "jira_assign_issue",
		label: "Jira Assign Issue",
		description: "Assign or unassign one mapped Jira issue.",
		promptSnippet: "Assign or unassign a Jira issue only after explicit user approval.",
		mutates: true,
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			accountId: Type.Union([Type.String(), Type.Null()], { description: "Jira accountId, or null to unassign when permitted." }),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			await jiraJson<void>(workspace, "PUT", `/issue/${encodeURIComponent(issue.key)}/assignee`, { body: { accountId: params.accountId }, signal });
			return {
				text: `${params.accountId ? "Assigned" : "Unassigned"} ${issue.key}`,
				details: { issueKey: issue.key, accountId: params.accountId, success: true },
			};
		},
	}),
	defineJiraTool<TransitionListParams>({
		name: "jira_get_transitions",
		label: "Jira Transitions",
		description: "List available transitions for one mapped Jira issue.",
		promptSnippet: "List available Jira issue transitions.",
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			expand: Type.Optional(Type.Array(Type.String({ description: "Optional expand values, e.g. transitions.fields." }))),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			const response = await jiraJson<{ transitions?: JiraTransition[] }>(workspace, "GET", `/issue/${encodeURIComponent(issue.key)}/transitions`, {
				query: params.expand?.length ? { expand: uniqueStrings(params.expand).join(",") } : undefined,
				signal,
			});
			const transitions = Array.isArray(response?.transitions) ? response.transitions : [];
			return { text: transitionSummary(transitions), details: { issueKey: issue.key, transitions, rawResponse: response } };
		},
	}),
	defineJiraTool<TransitionIssueParams>({
		name: "jira_transition_issue",
		label: "Jira Transition Issue",
		description: "Apply a transition to one mapped Jira issue. Prefer jira_get_transitions first.",
		promptSnippet: "Apply a Jira transition only after explicit user approval.",
		mutates: true,
		parameters: Type.Object({
			issueKey: Type.String({ description: "Issue key, e.g. ABC-123." }),
			transitionId: Type.String({ description: "Jira transition id." }),
			fields: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional transition fields." })),
			update: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional transition update payload." })),
		}),
		async run({ workspace, params, signal }) {
			const issue = await fetchIssue(workspace, params.issueKey, ["project"], undefined, signal);
			await jiraJson<void>(workspace, "POST", `/issue/${encodeURIComponent(issue.key)}/transitions`, {
				body: {
					transition: { id: params.transitionId },
					...(params.fields !== undefined ? { fields: params.fields } : {}),
					...(params.update !== undefined ? { update: params.update } : {}),
				},
				signal,
			});
			return {
				text: `Applied transition ${params.transitionId} to ${issue.key}`,
				details: { issueKey: issue.key, transitionId: params.transitionId, fields: params.fields, update: params.update, success: true },
			};
		},
	}),
	defineJiraTool<JiraPayload>({
		name: "jira_get_link_types",
		label: "Jira Link Types",
		description: "List Jira issue link types for the mapped Jira site.",
		promptSnippet: "List Jira issue link types available on the mapped site.",
		parameters: Type.Object({}),
		async run({ workspace, signal }) {
			const response = await jiraJson<{ issueLinkTypes?: Array<{ id?: string; name?: string; inward?: string; outward?: string }> }>(
				workspace,
				"GET",
				"/issueLinkType",
				{ signal },
			);
			const linkTypes = Array.isArray(response?.issueLinkTypes) ? response.issueLinkTypes : [];
			const text =
				linkTypes.map((type) => `${type.id}: ${type.name} (inward: ${type.inward}; outward: ${type.outward})`).join("\n") ||
				"No Jira issue link types returned.";
			return { text, details: { linkTypes, rawResponse: response } };
		},
	}),
	defineJiraTool<LinkIssuesParams>({
		name: "jira_link_issues",
		label: "Jira Link Issues",
		description: "Create a Jira issue link between two mapped issues. Exactly one of typeName or typeId is required.",
		promptSnippet: "Create a Jira issue link only after explicit user approval.",
		promptGuidelines: [COMMENT_FORMATTING_GUIDELINE],
		mutates: true,
		parameters: Type.Object({
			inwardIssueKey: Type.String({ description: "Jira inward issue key." }),
			outwardIssueKey: Type.String({ description: "Jira outward issue key." }),
			typeName: Type.Optional(Type.String({ description: "Jira link type name." })),
			typeId: Type.Optional(Type.String({ description: "Jira link type id." })),
			comment: Type.Optional(Type.String({ description: "Optional link comment. Supports Markdown-style links [text](https://...) and bare URLs." })),
		}),
		async run({ workspace, params, signal }) {
			const hasTypeName = typeof params.typeName === "string" && params.typeName.length > 0;
			const hasTypeId = typeof params.typeId === "string" && params.typeId.length > 0;
			if (hasTypeName === hasTypeId) throw new Error("jira_link_issues requires exactly one of typeName or typeId.");
			const inwardIssue = await fetchIssue(workspace, params.inwardIssueKey, ["project"], undefined, signal);
			const outwardIssue = await fetchIssue(workspace, params.outwardIssueKey, ["project"], undefined, signal);
			const body: Record<string, unknown> = {
				type: hasTypeId ? { id: params.typeId } : { name: params.typeName },
				inwardIssue: { key: inwardIssue.key },
				outwardIssue: { key: outwardIssue.key },
			};
			if (params.comment) body.comment = { body: textToAdf(params.comment) };
			await jiraJson<void>(workspace, "POST", "/issueLink", { body, signal });
			return {
				text: `Linked ${inwardIssue.key} and ${outwardIssue.key} with ${hasTypeId ? `type id ${params.typeId}` : `type ${params.typeName}`}`,
				details: {
					inwardIssueKey: inwardIssue.key,
					outwardIssueKey: outwardIssue.key,
					typeName: params.typeName,
					typeId: params.typeId,
					comment: params.comment,
					success: true,
				},
			};
		},
	}),
	defineJiraTool<DeleteIssueLinkParams>({
		name: "jira_delete_issue_link",
		label: "Jira Delete Issue Link",
		description: "Delete a Jira issue link after fetching it by id.",
		promptSnippet: "Delete a Jira issue link only after explicit user approval.",
		mutates: true,
		parameters: Type.Object({ linkId: Type.String({ description: "Jira issue link id." }) }),
		async run({ workspace, params, signal }) {
			const link = await jiraJson<JiraIssueLink>(workspace, "GET", `/issueLink/${encodeURIComponent(params.linkId)}`, { signal });
			const linkedIssues = [link?.inwardIssue, link?.outwardIssue].filter((issue): issue is JiraIssueRef => Boolean(issue));
			if (linkedIssues.length === 0) throw new Error(`Blocked Jira issue link ${params.linkId}: no linked issues found.`);
			await jiraJson<void>(workspace, "DELETE", `/issueLink/${encodeURIComponent(params.linkId)}`, { signal });
			return {
				text: `Deleted Jira issue link ${params.linkId}`,
				details: { linkId: params.linkId, linkedIssueKeys: linkedIssues.map((issue) => issue.key), deleted: true },
			};
		},
	}),
];

/** Build the common export manifest shape for single and batch exports. */
function manifest(workspace: JiraWorkspace, runDir: string, issues: ExportedIssuePaths[]) {
	return {
		generatedAt: new Date().toISOString(),
		siteUrl: workspace.siteUrl,
		profile: workspace.profileName,
		workspaceRoot: workspace.root,
		runDir,
		issues,
	};
}

/** Register the full Jira tool suite. */
export function registerJiraTools(pi: ExtensionAPI): void {
	for (const spec of toolSpecs) registerJiraTool(pi, spec);
}
