# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues at `K4F7/memebot`. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body "..."`
- Add a label: `gh issue edit <number> --add-label "..."`
- Remove a label: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v` when commands run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. If a bare number is ambiguous, try `gh pr view <number>` and then `gh issue view <number>`.

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.

When a skill says "fetch the relevant ticket", run `gh issue view <number> --comments`.

## Wayfinding

- A map is one issue labelled `wayfinder:map`.
- Child tickets use `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- Prefer GitHub sub-issues and native issue dependencies.
- If those features are unavailable, use task lists and a `Blocked by: #<number>` line.
- Claim a ticket with `gh issue edit <number> --add-assignee @me`.
- Resolve it by commenting with the result and closing the issue.

## Agent ticket execution

Before implementing an agent-grabbable ticket, follow the isolated worktree contract in `docs/agents/agent-delivery.md`. A handoff is ready only after the complete issue branch is committed, pushed to `origin`, and verified at its handed-off head SHA. `Blocked by` describes integration readiness: a dependent ticket remains blocked until every listed blocker has landed in `main` and the integrated result has passed verification. Work completed only in a local worktree or on another issue branch does not satisfy a blocker.
