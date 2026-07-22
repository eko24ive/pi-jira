# Maintenance

## Code map

Entrypoint and registration:

- `index.ts` — tiny extension entrypoint.
- `src/tools.ts` — Pi tool descriptors, shared registration wrapper, write-tool approval text.

Core runtime:

- `src/config.ts` — global config parsing and cwd-to-workspace resolution.
- `src/client.ts` — Jira REST JSON and attachment upload/download client.
- `src/issues.ts` — single/bulk issue reads, validated comment pagination, compact search, and token-following export search.
- `src/create.ts` — create metadata and create issue payload assembly.

Formatting and export:

- `src/adf.ts` — best-effort ADF text conversion, plain-text comment ADF, and shared description normalization.
- `src/format.ts` — compact issue/comment/link/transition summaries and Markdown.
- `src/exporter.ts` — export run paths, file writes, truncation full-output files.
- `src/types.ts` — config, workspace, narrow Jira DTO/view types.

## Invariants

Keep these intact:

- no project-local Jira config;
- no env-var indirection for Jira credentials;
- no default JQL; `jira_search` requires explicit `jql`;
- no generic exposed `jira_request` tool;
- create/edit payloads stay raw Jira fields/update payloads except string descriptions are converted to Jira ADF;
- no custom confirmation UI;
- write tools must centrally include the explicit approval line;
- comment bodies should render useful links via Markdown-style links or bare URLs;
- attachment bodies are never downloaded by issue read/export tools;
- uploads require an explicit issue key and local file paths;
- all attachments use Jira's documented multipart REST endpoint and are uploaded unchanged;
- the extension does not transcode or invoke ffmpeg;
- downloads require an issue key plus explicit attachment IDs, write atomically, and never overwrite existing files;
- bulk issue reads use `/issue/bulkfetch` rather than repeated single-issue calls;
- search details stay compact and never retain the full raw Jira response;
- JSON and paginated response shapes are validated instead of silently treated as empty data;
- permanent issue deletion defaults to preserving subtasks by refusing deletion when they exist;
- tool failures throw, not success-return error text;
- model-visible output stays bounded;
- file writes go through Pi's mutation queue;
- do not print or log the API token.

## Development

From the repository root:

```bash
pnpm install
pnpm format
pnpm test
pnpm build:smoke
pi --no-extensions -e ./index.ts
```

Before calling work done:

1. Run the extension load smoke check.
2. Run mocked single-page, token-paginated, and bulk issue-read checks.
3. Run malformed JSON/comment-page and atomic download checks.
4. Run mocked `jira_get_createmeta` and `jira_create_issue` checks if create code changed.
5. Run mocked REST upload plus issue-deletion checks if attachment or deletion code changed.
6. Run a mocked `jira_export_issues` check if export code changed.
7. Re-read changed code for token leakage, fake-success errors, broad permission policy, and unbounded output.

Pi auto-discovers a development checkout at `~/.pi/agent/extensions/jira/index.ts`. Run `/reload` after editing extension code or config.
