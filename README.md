# @eko24ive/pi-jira

Pi package for Jira Cloud work from mapped local workspaces. It exposes named Jira tools for search, reads, issue creation and deletion, exports, attachment uploads and downloads, comments, issue edits, transitions, and issue links.

## Install

```bash
pi install git:github.com/eko24ive/pi-jira
```

Try it for one run without installing:

```bash
pi -e git:github.com/eko24ive/pi-jira
```

This extension is deliberately **not** a generic Jira REST client, storage manager, workflow orchestrator, or custom approval UI.

## Why this exists

The failure mode this extension avoids:

```txt
agent opens browser or invents REST calls -> unclear site/project/auth -> accidental broad Jira action
```

The intended flow:

```txt
global user config -> mapped cwd -> named Jira tool -> concise result
```

Workspace mapping is only an enablement gate: Jira tools run when `ctx.cwd` is inside a configured `workspace.root`. Jira account permissions own access to individual Jira projects/issues. Search requires explicit JQL; there is no default JQL and no predeclared project-key list.

## Config

Config lives at:

```txt
~/.pi/agent/jira.json
```

Example:

```json
{
  "version": 1,
  "profiles": {
    "work": {
      "siteUrl": "https://your-site.atlassian.net",
      "email": "you@example.com",
      "apiToken": "paste-atlassian-api-token-here"
    }
  },
  "workspaces": [
    {
      "root": "/path/to/your/workspace",
      "profile": "work"
    }
  ],
  "export": {
    "baseDir": "/tmp/pi-jira-${USER}"
  }
}
```

Keep the file private:

```bash
chmod 600 ~/.pi/agent/jira.json
```

Config rules:

- `siteUrl` must be an `https://*.atlassian.net` origin.
- `email` and `apiToken` are read directly from this user-owned config file.
- `workspaces[].root` controls where Jira tools are enabled.
- If multiple roots match the current cwd, the deepest root wins.
- `export.baseDir` is where export runs and truncated full outputs are written.
- The extension does not clean export files or manage retention.

## Tool chooser

| Need | Use | Avoid |
| --- | --- | --- |
| Find issues | `jira_search` with explicit JQL | relying on a hidden default query |
| Read one issue | `jira_get_issue` | broad search fields for descriptions/comments |
| Read multiple issues | `jira_get_issues` | repeated `jira_get_issue` calls |
| Read comments | `jira_get_comments` | fetching comments through search |
| Save issue/comments | `jira_export_issues` | downloading attachment bodies implicitly |
| Upload attachments | `jira_upload_attachments` | uploading before explicit user approval |
| Download attachments | `jira_download_attachments` | repeated issue-membership checks |
| Add/edit/delete comment | `jira_add_comment` / `jira_update_comment` / `jira_delete_comment` | calling before explicit user approval |
| Inspect creatable fields | `jira_get_createmeta` | guessing required create fields |
| Create/delete an issue | `jira_create_issue` / `jira_delete_issue` | mutating before explicit user approval |
| Inspect editable fields | `jira_get_editmeta` | guessing raw field names |
| Edit/assign/transition | `jira_edit_issue` / `jira_assign_issue` / `jira_transition_issue` | field-specific wrappers in v1 |
| Work with links | `jira_get_link_types` / `jira_link_issues` / `jira_delete_issue_link` | generic REST calls |

## Tool reference

### `jira_search`

Search Jira with explicit JQL. Does not return descriptions or comments. Results always include browse links and parent keys when present; explicitly requested extra fields are shown in compact form. Raw Jira search payloads are not retained in session details.

```ts
{
  jql: string;
  maxResults?: number;    // page size, 1–100; default 50
  fields?: string[];      // extra fields shown compactly; description/comment blocked
  nextPageToken?: string;
}
```

### `jira_get_issue`

Read one issue and return compact text plus raw JSON details.

```ts
{
  issueKey: string;
  fields?: string[];
  expand?: string[];
}
```

### `jira_get_issues`

Bulk-read up to 100 explicit issue IDs or keys as compact candidate summaries. Use `jira_get_issue` when a full description or raw issue details are needed.

```ts
{
  issueIdsOrKeys: string[];
  fields?: string[];
  expand?: string[];
}
```

### `jira_get_comments`

Fetch and validate all comment pages for one issue.

```ts
{
  issueKey: string;
}
```

### `jira_export_issues`

Batch export by explicit keys or by JQL search results. JQL exports follow `nextPageToken` until the requested total is reached.

```ts
{
  issueKeys?: string[];
  jql?: string;
  maxResults?: number;
  outputDir?: string;
}
```

Exactly one of `issueKeys` or `jql` is required.

### `jira_upload_attachments`

Upload one or more explicit local files through Jira's documented REST attachment endpoint. Relative paths resolve from the active workspace, and every path is validated before the request starts. Files are uploaded unchanged; the extension does not transcode videos.

```ts
{
  issueKey: string;
  filePaths: string[];
}
```

### `jira_download_attachments`

Download several attachments from one issue after a single membership check. Filenames are prefixed with attachment IDs to prevent local collisions after sanitization.

```ts
{
  issueKey: string;
  attachmentIds: string[];
  outputDir?: string;
}
```

### `jira_get_createmeta`

Inspect Jira's create-issue metadata: projects, issue types, and required fields. Use this before `jira_create_issue` when project/type required fields are unknown.

```ts
{
  projectKeys?: string[];
  projectIds?: string[];
  issueTypeIds?: string[];
  issueTypeNames?: string[];
  expand?: string[]; // defaults to projects.issuetypes.fields
}
```

### `jira_create_issue`

Create an issue with raw Jira create fields. This keeps Jira's site-specific field model intact instead of inventing a leaky wrapper.

```ts
{
  fields: Record<string, unknown>; // project, issuetype, summary, plus required site fields
  update?: Record<string, unknown>;
  properties?: unknown[];
  historyMetadata?: Record<string, unknown>;
  transition?: Record<string, unknown>;
}
```

Example:

```json
{
  "fields": {
    "project": { "key": "PROJ" },
    "issuetype": { "name": "Task" },
    "summary": "Investigate candidate import failure",
    "description": "See [logs](https://example.com/logs)."
  }
}
```

If `fields.description` is a string, `jira_create_issue` converts it to Jira ADF and linkifies Markdown-style links/bare URLs. `jira_edit_issue` applies the same conversion. If `fields.description` is already an object, it is sent as-is.

### `jira_delete_issue`

Permanently delete one issue directly by key. Jira refuses deletion when subtasks exist unless `deleteSubtasks` is explicitly enabled.

```ts
{
  issueKey: string;
  deleteSubtasks?: boolean; // default false
}
```

### Write tools

These tools mutate Jira:

- `jira_add_comment`
- `jira_update_comment`
- `jira_delete_comment`
- `jira_create_issue`
- `jira_delete_issue`
- `jira_upload_attachments`
- `jira_edit_issue`
- `jira_assign_issue`
- `jira_transition_issue`
- `jira_link_issues`
- `jira_delete_issue_link`

Each write-tool description includes the approval contract:

```txt
Before calling jira_X, get explicit user approval using existing mechanisms (ask_user if available, otherwise plaintext). This tool does not prompt by itself.
```

The extension intentionally does not implement custom confirmation UI.

### Comment formatting brief

For Jira comments, tell the agent to prefer Jira-renderable link text:

```txt
[PR #42](https://github.com/example/project/pull/42)
```

The formatter converts Markdown-style links to Jira ADF link marks. Bare `https://...` URLs are linkified too, but display as the full URL.

## Operational model

### Workspace resolution

Every tool call resolves workspace context:

1. Read `~/.pi/agent/jira.json`.
2. Resolve `ctx.cwd` and configured workspace roots with `realpath`.
3. Choose the deepest root containing `ctx.cwd`.
4. Load the mapped profile.
5. Use the profile's site URL, email, API token, and export base directory.

If no workspace matches, tools fail with:

```txt
Jira disabled here: cwd is not under any configured jira workspace root.
```

### Jira requests

- Uses Jira Cloud REST API v3 under `/rest/api/3`.
- Uses Basic auth with `email:apiToken`.
- JSON calls send `Accept: application/json` and `Content-Type: application/json` when a body is present.
- All attachment uploads use Jira's documented multipart REST endpoint with the required `X-Atlassian-Token: no-check` header.
- Download calls stream to a temporary sibling file through Pi's mutation queue, then rename atomically; existing files are never overwritten.
- Non-2xx responses throw concise Jira errors; 429 includes `Retry-After` when present.
- JSON endpoints reject malformed successful responses instead of casting text to typed data.

### Output and files

- Tool output is bounded with Pi's truncation utilities.
- Truncated full output is saved under `export.baseDir/tool-output/`.
- Export runs create timestamped directories under `export.baseDir` unless `outputDir` is provided.
- Attachment bodies are uploaded only by `jira_upload_attachments` and downloaded only by `jira_download_attachments`.

### ADF handling

Jira descriptions/comments use Atlassian Document Format.

- Reads use best-effort `adfToText` for model-readable text.
- Comment writes use minimal `textToAdf` conversion.
- Create and edit writes convert string `fields.description` with the same `textToAdf` helper.
- `textToAdf` linkifies Markdown-style links and bare `https://...` URLs.
- There is no general Markdown parser in v1.

## Maintenance

See [docs/maintenance.md](docs/maintenance.md) for the code map, invariants, and development workflow.

## Requirements

- Pi extension runtime.
- Jira Cloud site.
- Atlassian API token from `https://id.atlassian.com/manage-profile/security/api-tokens`.
