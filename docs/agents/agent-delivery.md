# Isolated Agent Ticket Delivery

Every agent-grabbable ticket follows one issue, one branch, and one dedicated worktree. The shared `main` checkout is a coordination surface, not an implementation workspace.

An agent-grabbable ticket is a GitHub issue carrying the canonical `ready-for-agent` label. An issue may explicitly require this contract before it receives that label, as #43 did for its downstream tickets.

## Roles

- The ticket agent implements and verifies exactly one issue in its issue worktree, then hands the branch off.
- The designated integrator lands completed branches into `main`, verifies the integrated result, and records when downstream work is ready.

The same person may perform both roles at different times, but must keep ticket implementation and integration in separate worktrees.

## Naming

- Branch: `issue/<number>-<short-slug>`
- Worktree directory: `../memebot-worktrees/issue-<number>`

Use the GitHub issue number and a stable lowercase, hyphenated slug. Do not rename either during handoff.

## Creation and dependency readiness

Before creating a ticket worktree:

1. Read the issue, including its `Blocked by` and `Execution isolation` sections.
2. Confirm every declared blocker has been integrated into `main` and verified there. An unfinished, unmerged, or merely handed-off blocker branch does not make a dependent ticket ready.
3. Fetch the remote and identify the latest `origin/main` commit with `git fetch origin main` and `git rev-parse origin/main`. Do not use a stale local `main` branch as the base.
4. Create the branch and dedicated worktree from that exact commit:

   ```sh
   git worktree add -b issue/<number>-<short-slug> ../memebot-worktrees/issue-<number> origin/main
   ```

5. Record the resulting commit as the base commit before making changes.

If any blocker is not integrated and verified, leave the ticket blocked. Do not pull a blocker branch into the ticket branch to manufacture readiness.

## Isolation rules

A ticket agent must never:

- edit files in the shared `main` checkout;
- reuse another issue's branch or worktree;
- implement more than one issue in the ticket worktree; or
- merge a sibling issue branch into the ticket branch.

Fetches and read-only inspection of repository state are allowed from the shared checkout. All ticket writes, generated files, dependency installs, tests, and commits belong in the dedicated issue worktree.

## Live browser verification inside the worktree

A ticket worktree may host its own `app/` Koishi instance to run live browser
acceptance without touching the shared `main` checkout. The repository's
`.gitignore` ignores `app/`, so none of these files enter the issue branch.

From the worktree root, follow the local-instance setup documented in the root
`README.md`, but inside the worktree's own `app/`:

1. `yarn build` first so the `file:` dependencies snapshot current plugin output.
2. Create `app/package.json` depending on `file:../plugins/memebot-*` (with the
   `koishi-plugin-memebot-access` resolution), and an empty `app/yarn.lock`.
3. Configure `app/koishi.yml` with Server, Console, Database, Sandbox, and the
   plugins under test.
4. `cd app && yarn install`, then `yarn start` in a separate terminal.
5. Run the live suites from the worktree root, for example:

   ```powershell
   $env:MEMEBOT_ARCHIVE_WEBUI_URL = 'http://127.0.0.1:5140'
   yarn workspace koishi-plugin-memebot-archive test:browser:required
   ```

Stop the instance and delete the worktree `app/` before cleanup; it is never
committed or pushed. The shared `main` checkout's own `app/` stays untouched.

## Handoff

Commit the complete ticket change and push the issue branch before handoff. The following checks must all succeed, and `git status --short` must produce no output:

```sh
set -eu
branch="$(git branch --show-current)"
test -n "$branch"
test -z "$(git status --short)"
git push --set-upstream origin "$branch"
head="$(git rev-parse HEAD)"
test "$(git ls-remote --exit-code origin "refs/heads/$branch" | cut -f1)" = "$head"
```

Post or send a handoff containing every field in this template:

- Issue: `#<number>` and URL
- Branch: `issue/<number>-<short-slug>`
- Remote branch: `origin` and `refs/heads/issue/<number>-<short-slug>`
- Base commit: `<full SHA>`
- Head commit: `<full SHA>`
- Change summary: `<what changed and any important decisions>`
- Verification results: `<commands and pass/fail outcome>`
- Push verification: `<git ls-remote output showing the remote branch at the full head SHA>`

Call out remaining risks or manual checks after the required fields. A dirty worktree, an uncommitted fix, local-only commits, an unpushed issue branch, or a report without exact remote evidence is not ready for handoff or integration.

## Integration and downstream readiness

The designated integrator uses a clean integration checkout, not an issue worktree or the shared `main` checkout, and lands ready branches into `main` in dependency order. For each branch, the integrator:

1. runs `git fetch origin --prune`, checks that `refs/remotes/origin/<branch>` equals the full handed-off head SHA, and independently confirms the same SHA with `git ls-remote --exit-code origin "refs/heads/$branch"`;
2. reviews the ticket diff and verification evidence;
3. integrates the fetched remote branch into the latest `origin/main` without adding sibling work to the ticket branch;
4. runs the required repository checks on the integrated result;
5. pushes `main` and confirms its CI passes; and
6. records the integrated commit and verification result on the issue.

Downstream tickets remain blocked until the relevant integration passes on `main`. A green issue branch, open pull request, handoff, or local merge is not sufficient.

Every downstream worktree is created from the latest fetched `origin/main`, never from a local-only commit, a stale local `main`, or a sibling issue branch.

## Cleanup

Retain the issue branch and worktree while integration or verification is pending. After the integrated `main` result passes and the handoff record is complete, remove the worktree with `git worktree remove <path>`, then delete the local issue branch. Delete a remote issue branch only when repository retention policy permits it. Never force-remove a dirty worktree; preserve or hand off unexpected changes first.
