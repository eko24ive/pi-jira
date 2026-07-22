/**
 * Shared Jira extension contracts.
 *
 * These are intentionally narrow DTO/view types for the fields this extension
 * reads. Raw Jira edit/update payloads remain generic only at the write-tool
 * boundary because Jira field schemas are site-specific.
 */
export const CONFIG_DISPLAY_PATH = "~/.pi/agent/jira.json";
// biome-ignore lint/suspicious/noTemplateCurlyInString: ${USER} is expanded later as a configured path placeholder.
export const DEFAULT_EXPORT_BASE_DIR = "/tmp/pi-jira-${USER}";

export const DEFAULT_SEARCH_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated", "parent"];

export const DEFAULT_ISSUE_FIELDS = [
	"project",
	"summary",
	"description",
	"status",
	"issuetype",
	"priority",
	"assignee",
	"reporter",
	"labels",
	"components",
	"fixVersions",
	"created",
	"updated",
	"parent",
	"attachment",
	"issuelinks",
];

export const SEARCH_BLOCKED_FIELDS = new Set(["description", "comment", "comments"]);

/** One Jira Cloud site and its plaintext user-owned credentials. */
export type JiraProfileConfig = {
	siteUrl: string;
	email: string;
	apiToken: string;
};

/** Maps a local workspace root to a configured Jira profile. */
export type JiraWorkspaceConfig = {
	root: string;
	profile: string;
};

export type JiraConfig = {
	version?: number;
	profiles: Record<string, JiraProfileConfig>;
	workspaces: JiraWorkspaceConfig[];
	export?: {
		baseDir?: string;
	};
};

/** Resolved runtime workspace used by every Jira tool call. */
export type JiraWorkspace = {
	profileName: string;
	siteUrl: string;
	email: string;
	apiToken: string;
	root: string;
	exportBaseDir: string;
};

export type JiraUser = {
	displayName?: string;
	name?: string;
	emailAddress?: string;
	accountId?: string;
};

export type JiraNamed = {
	id?: string;
	name?: string;
	value?: string;
	key?: string;
};

export type JiraProject = {
	key?: string;
};

export type JiraAttachmentDto = {
	id?: string | number;
	filename?: string;
	size?: number;
	mimeType?: string;
	created?: string;
	author?: JiraUser;
	content?: string;
};

export type JiraIssueRef = {
	key?: string;
	fields?: {
		project?: JiraProject;
	};
};

export type JiraIssueLink = {
	id?: string;
	type?: JiraNamed & { inward?: string; outward?: string };
	inwardIssue?: JiraIssueRef;
	outwardIssue?: JiraIssueRef;
};

/** Jira issue fields this extension knows how to summarize/export. */
export type JiraIssueFields = Record<string, unknown> & {
	project?: JiraProject;
	summary?: string;
	description?: unknown;
	status?: JiraNamed;
	issuetype?: JiraNamed;
	priority?: JiraNamed;
	assignee?: JiraUser | null;
	reporter?: JiraUser | null;
	labels?: string[];
	components?: JiraNamed[];
	fixVersions?: JiraNamed[];
	created?: string;
	updated?: string;
	parent?: JiraIssueRef;
	attachment?: JiraAttachmentDto[];
	issuelinks?: JiraIssueLink[];
};

export type JiraIssue = {
	id?: string;
	key: string;
	self?: string;
	fields?: JiraIssueFields;
};

export type JiraComment = {
	id: string;
	self?: string;
	author?: JiraUser;
	created?: string;
	updated?: string;
	body?: unknown;
};

export type CompactIssue = {
	key: string;
	url: string;
	summary: string;
	status?: string;
	type?: string;
	priority?: string;
	assignee?: string;
	parentKey?: string;
	updated?: string;
	requestedFields?: Record<string, unknown>;
};

export type JiraTransition = {
	id?: string;
	name?: string;
	to?: JiraNamed;
	fields?: Record<string, unknown>;
};

export type ExportedIssuePaths = {
	issueKey: string;
	directory: string;
	issueJson: string;
	issueMarkdown: string;
	commentsJson: string;
	commentsMarkdown: string;
};

/** Tool handler output before shared truncation/result wrapping. */
export type TextOutput = {
	text: string;
	details?: Record<string, unknown>;
};
