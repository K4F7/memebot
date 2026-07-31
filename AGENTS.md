# Repository Instructions

## Repository scope

This public repository contains standalone Koishi plugins only. Publishable plugin packages live under `plugins/`, and each package must remain independently installable, configurable, buildable, and publishable. A plugin must not require another `memebot-*` plugin at runtime.

## Local Koishi development

- Keep the local Koishi development instance in `/app` (the `app/` directory at the repository root).
- Create and manage that instance using the official Koishi scaffold and Yarn workflow.
- Enter `/app` before starting Koishi, then run `yarn dev`.
- Use local `file:` dependencies from `/app/package.json` when loading packages from `../plugins/`.
- Keep `/app` as an independent Yarn project with its own `package.json`, `yarn.lock`, and dependencies. Do not add `/app` to the root Yarn workspaces.
- Never commit or publish `/app`, its Koishi configuration, database, logs, cache, environment files, or installed dependencies. The entire `/app/` directory is ignored by Git.

## Verification

Run plugin repository checks from the repository root:

```sh
yarn typecheck
yarn build
```

Run the local Koishi development instance separately:

```sh
cd app
yarn dev
```

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `K4F7/memebot`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels without renaming. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain documentation layout. See `docs/agents/domain.md`.
