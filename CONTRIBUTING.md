# Contributing

Thanks for contributing to `@eko24ive/pi-jira`.

## Development setup

```bash
pnpm install
pi --no-extensions -e ./index.ts
```

## Validation

Before sharing a change, run:

```bash
pnpm format
pnpm test
pnpm build:smoke
```

This project uses conventional commits and semantic-release. Keep changes focused, preserve the explicit-approval contract for Jira mutations, and update the README when public behavior changes.
