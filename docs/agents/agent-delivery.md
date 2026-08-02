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
3. Fetch the remote and identify the latest `main` commit with `git fetch origin main` and `git rev-parse origin/main`.
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

## Handoff

Commit the complete ticket change before handoff. Post or send a handoff containing every field in this template:

- Issue: `#<number>` and URL
- Branch: `issue/<number>-<short-slug>`
- Base commit: `<full SHA>`
- Head commit: `<full SHA>`
- Change summary: `<what changed and any important decisions>`
- Verification results: `<commands and pass/fail outcome>`

Call out remaining risks or manual checks after the required fields. A dirty worktree, an uncommitted fix, or a report without exact commits is not ready for integration.

## Integration and downstream readiness

The designated integrator uses a clean integration checkout, not an issue worktree or the shared `main` checkout, and lands ready branches into `main` in dependency order. For each branch, the integrator:

1. checks that the handoff base and head commits exist and match the branch;
2. reviews the ticket diff and verification evidence;
3. integrates the branch into the latest `main` without adding sibling work to the ticket branch;
4. runs the required repository checks on the integrated result;
5. pushes `main` and confirms its CI passes; and
6. records the integrated commit and verification result on the issue.

Downstream tickets remain blocked until the relevant integration passes on `main`. A green issue branch, open pull request, handoff, or local merge is not sufficient.

## Cleanup

Retain the issue branch and worktree while integration or verification is pending. After the integrated `main` result passes and the handoff record is complete, remove the worktree with `git worktree remove <path>`, then delete the local issue branch. Delete a remote issue branch only when repository retention policy permits it. Never force-remove a dirty worktree; preserve or hand off unexpected changes first.
