# Repository verification matrix

This is the authoritative verification matrix for contributors, pull-request
CI, `main` CI, and plugin release. The public command surface stays
`yarn typecheck`, `yarn test`, and `yarn build`. Yakumo discovers the
`plugins/*` workspaces and orchestrates cross-package type checking and
builds; repository-owned checks stay explicit.

## Required sequence

Run these commands from a clean checkout of the repository root. Do not skip
or reorder them.

```sh
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn check:plugin-loads
yarn check:plugin-artifacts
```

| Gate | Command | What it proves |
| --- | --- | --- |
| Immutable install | `yarn install --immutable` | The lockfile resolves every plugin workspace without network drift. |
| Typecheck | `yarn typecheck` | Every plugin source, the Access Console client, and repository test sources typecheck. Plugin loading is a later gate and must not be treated as part of typecheck. |
| Test | `yarn test` | Plugin unit tests, repository policy tests, the Koishi Mock harness, Archive fail-closed reads, artifact-contract tests, and local-app smoke helpers all pass. |
| Build | `yarn build` | Yakumo compiles every plugin's declared runtime and type artifacts. Access still runs its Vite Console client build. |
| Plugin entry loading | `yarn check:plugin-loads` | Each built CommonJS entry loads as a Koishi plugin with an `apply` function. This gate runs only after the explicit build. |
| Package artifacts | `yarn check:plugin-artifacts` | Yarn-packed tarballs, not workspace directories, ship the declared entries, contain no `workspace:` ranges, and load as Koishi plugins. |

CI is one service-free `verify` job. It does not start Payload, PostgreSQL,
staging credentials, npm write tokens, or the ignored local Koishi
application.

## Manual local integration

`app/` remains an independent, Git-ignored Yarn project. Its startup smoke is
a manual integration or release check, not a clean-checkout CI gate:

```sh
yarn smoke:local-app
```

The helper fails when `app/` is missing, the five local plugins are not
configured, required services are absent, Console is not ready, or a plugin
fails to start.

## Archive acceptance

Current Archive acceptance is the fail-closed QQ read surface when unconfigured, plus the bound Mock-and-mock-HTTP read surface documented in
[`archive-qq-shortcuts.md`](archive-qq-shortcuts.md) and
[`archive-console-browser.md`](archive-console-browser.md). Archive management
does not live in this repository.
