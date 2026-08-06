# Repository Instructions

## Repository scope

This public repository contains standalone Koishi plugins only. Publishable plugin packages live under `plugins/`, and each package must remain independently installable, configurable, buildable, and publishable. A plugin must not require another `memebot-*` plugin at runtime, except that plugins with protected operations require `memebot-access` as their central authorization source. `memebot-access` must not depend on any business plugin. See `docs/adr/0010-centralize-plugin-authorization.md`.

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
- Push each release tag with a separate `git push` command. GitHub does not create tag push events when more than three tags are pushed at once.
- `.github/workflows/publish.yml` validates the tag, checks and builds the full repository, then publishes only the matched package to npm using `NPM_TOKEN`. Prerelease versions use their first suffix component as the npm dist-tag (`alpha`, `beta`, or `rc`); stable versions use `latest`.
- A successful npm publish is the release outcome. Do not create a GitHub Release unless explicitly requested.
- Never reuse or move a published release tag. Create a new patch version for follow-up fixes.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `K4F7/memebot`. See `docs/agents/issue-tracker.md`.

### Agent ticket delivery

Implement every agent-grabbable ticket in its own branch and dedicated worktree. Do not edit the shared `main` checkout. Commit and push the complete issue branch before handoff. See `docs/agents/agent-delivery.md` for creation, remote verification, handoff, integration, and cleanup.

### Triage labels

Use the five canonical triage labels without renaming. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain documentation layout. See `docs/agents/domain.md`.
