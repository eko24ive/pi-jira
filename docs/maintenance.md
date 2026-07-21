# Maintenance

## Code map

Entrypoint and registration:

- `index.ts` — tiny extension entrypoint.
- `src/tools.ts` — Pi tool descriptors, shared registration wrapper, write-tool approval text.

Core runtime:

- `src/config.ts` — global config parsing and cwd-to-workspace resolution.
- `src/client.ts` — Jira REST JSON and download client.
- `src/issues.ts` — issue/comment/search helpers.
- `src/create.ts` — create metadata, create issue payload normalization, string description ADF conversion.

Formatting and export:

- `src/adf.ts` — best-effort ADF text conversion and plain-text comment ADF.
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
- downloads require both `issueKey` and `attachmentId`;
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
2. Run a mocked `jira_search` check with explicit JQL.
3. Run mocked `jira_get_createmeta` and `jira_create_issue` checks if create code changed.
4. Run a mocked `jira_export_issue` check if export code changed.
5. Re-read changed code for token leakage, fake-success errors, broad permission policy, and unbounded output.

Pi auto-discovers a development checkout at `~/.pi/agent/extensions/jira/index.ts`. Run `/reload` after editing extension code or config.
