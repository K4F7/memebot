# Repository Instructions

## Repository scope

This public repository contains standalone Koishi plugins only. Publishable plugin packages live under `plugins/`, and each package must remain independently installable, configurable, buildable, and publishable. A plugin must not require another `memebot-*` plugin at runtime.

## Local Koishi development

- Keep the local Koishi development instance in `/app` (the `app/` directory at the repository root).
- Create and manage that instance using the official Koishi scaffold and Yarn workflow.
- Enter `/app` before starting Koishi, then run `yarn start`.
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
yarn start
```

## Releases

- Versions are managed independently in each `plugins/memebot-*/package.json`.
- Bump every package affected by a shared build or runtime change. Use semantic versioning.
- Before releasing, run `yarn install --immutable`, `yarn typecheck`, `yarn build`, and the affected package tests from the repository root.
- Push the release commit to `main` and wait for `.github/workflows/ci.yml` to pass.
- Continue an existing prerelease channel by incrementing its numeric suffix, for example `0.1.1-alpha.0` to `0.1.1-alpha.1`. Check npm before choosing the next version.
- Publish one plugin at a time by pushing a tag named `<plugin-directory>-v<version>`, for example `memebot-faq-v0.1.1-alpha.1`.
- The tag version must exactly match that plugin's `package.json`. Releasing multiple plugins requires one tag per plugin.
- `.github/workflows/publish.yml` validates the tag, checks and builds the full repository, then publishes only the matched package to npm using `NPM_TOKEN`. Prerelease versions use their first suffix component as the npm dist-tag (`alpha`, `beta`, or `rc`); stable versions use `latest`.
- Never reuse or move a published release tag. Create a new patch version for follow-up fixes.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `K4F7/memebot`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels without renaming. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain documentation layout. See `docs/agents/domain.md`.
