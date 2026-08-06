# Agent Ticket Delivery

Every agent-grabbable ticket is implemented on its own issue branch, committed, pushed to `origin`, and handed off for integration. Branches are created from the latest `origin/main`.

An agent-grabbable ticket is a GitHub issue carrying the canonical `ready-for-agent` label. An issue may explicitly require this contract before it receives that label, as #43 did for its downstream tickets.

## Roles

- The ticket agent implements and verifies exactly one issue on its issue branch, then hands the branch off.
- The designated integrator lands completed branches into `main`, verifies the integrated result, and records when downstream work is ready.

The same person may perform both roles at different times.

## Naming

- Branch: `issue/<number>-<short-slug>`

Use the GitHub issue number and a stable lowercase, hyphenated slug. Do not rename either during handoff.

## Creation and dependency readiness

Before creating the ticket branch:

1. Read the issue, including its `Blocked by` and `Execution isolation` sections.
2. Confirm every declared blocker has been integrated into `main` and verified there. An unfinished, unmerged, or merely handed-off blocker branch does not make a dependent ticket ready.
3. Fetch the remote and identify the latest `origin/main` commit with `git fetch origin main` and `git rev-parse origin/main`. Do not use a stale local `main` branch as the base.
4. Create the branch from that exact commit:

   ```sh
   git checkout -b issue/<number>-<short-slug> origin/main
   ```

5. Record the resulting commit as the base commit before making changes.

If any blocker is not integrated and verified, leave the ticket blocked. Do not pull a blocker branch into the ticket branch to manufacture readiness.

## Isolation rules

A ticket agent must never:

- reuse another issue's branch;
- implement more than one issue on a single issue branch; or
- merge a sibling issue branch into the ticket branch.

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

Call out remaining risks or manual checks after the required fields. A dirty checkout, an uncommitted fix, local-only commits, an unpushed issue branch, or a report without exact remote evidence is not ready for handoff or integration.

## Integration and downstream readiness

The designated integrator lands ready branches into `main` in dependency order. For each branch, the integrator:

1. runs `git fetch origin --prune`, checks that `refs/remotes/origin/<branch>` equals the full handed-off head SHA, and independently confirms the same SHA with `git ls-remote --exit-code origin "refs/heads/$branch"`;
2. reviews the ticket diff and verification evidence;
3. integrates the fetched remote branch into the latest `origin/main` without adding sibling work to the ticket branch;
4. runs the required repository checks on the integrated result;
5. pushes `main` and confirms its CI passes; and
6. records the integrated commit and verification result on the issue.

Downstream tickets remain blocked until the relevant integration passes on `main`. A green issue branch, open pull request, handoff, or local merge is not sufficient.

Every downstream branch is created from the latest fetched `origin/main`, never from a local-only commit, a stale local `main`, or a sibling issue branch.

## Cleanup

Retain the issue branch while integration or verification is pending. After the integrated `main` result passes and the handoff record is complete, delete the local issue branch. Delete a remote issue branch only when repository retention policy permits it.
