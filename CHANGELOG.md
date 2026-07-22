# Changelog

Notable changes to this project are documented here.

## Unreleased

- Add compact bulk issue reads, token-complete JQL exports, and linked search results.
- Add attachment upload, transactional multi-attachment download, and permanent issue deletion tools.
- Remove redundant singular export/download tools and duplicate attachment export artifacts.
- Upload every attachment unchanged through Jira's documented multipart REST endpoint.
- Make downloads atomic and non-overwriting.
- Validate JSON, comment pages, searches, bulk reads, transitions, link types, and mutation response identifiers.
- Convert string descriptions to Jira ADF for both issue creation and editing.
- Remove Commitizen, commitlint, Lefthook, and Ultracite in favor of direct Biome checks.
