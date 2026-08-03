# Intake Sandbox route evidence

Issue: #36  
Date: 2026-08-03  
Base: `f0bf8dbd4d9d83344ca5b5b089de18dfaef10bb1`

## Environment

- Created the ignored `app/` project with the official `create-koishi@6.4.0` scaffold.
- Loaded local `file:` builds of all five memebot plugins with SQLite, Console, and Sandbox.
- Ran `yarn smoke:local-app` at 12:53 CST on `http://127.0.0.1:5145`; all required plugins loaded without startup failures.
- Exercised the route in Chromium through the Koishi Sandbox, then ran the Playwright console check. It reported zero browser-console errors.

The first real SQLite attempt exposed that the draft key used a NUL separator. The memory-backed Mock database accepted it, but the SQLite driver interpolated the NUL into its generated draft lookup and returned `unrecognized token: "'Alice"`. The route now uses a JSON tuple key, and the regression test rejects control characters and ambiguous component combinations. Draft operations query by submitter and source fields, so an in-flight draft persisted with the legacy key can still be completed or cancelled.

## Member route

The Sandbox user completed these flows in private-message mode:

1. `feedback` accepted `第一条反馈`, the non-exact text `提交一下`, and `第二条反馈` as three separate messages. Only the exact `提交` completed the draft as stable ID `反馈#1`.
2. `suggest` accepted `建议第一段` and the non-exact text `取消一下`. Only the exact `取消` discarded the draft, and no suggestion record appeared.
3. `submit` accepted two separate message parts. Exact `提交` completed the draft as stable ID `投稿#1`.
4. Because the Sandbox adapter cannot deliver to the configured QQ notification target, both completed drafts reported that the record was saved while administrator notification was delayed. This demonstrates that persistence succeeds independently from delivery.
5. After stopping and restarting Koishi against the same SQLite database, `intake` still returned `投稿#1 pending-review` and `反馈#1 pending`.

## Administration route

With Sandbox authority set to 4, the compact administration commands exercised `反馈#1` as follows:

1. First and repeated `intake.admin.claim` both showed assignee `Alice`, while progress remained `pending`.
2. `intake.admin.transfer 反馈#1 10001` transferred to a persisted explicit administrator.
3. `intake.admin.unassign 反馈#1` cleared assignment without changing progress.
4. `intake.admin.status 反馈#1 processing` explicitly advanced progress.
5. `intake.admin.close` removed the record from the active queue while preserving `processing`.
6. `intake.admin.reopen` restored active-queue presence and still preserved `processing`.

This confirms that assignment, handling progress, and active-queue presence are independent state dimensions as required by ADR 0003.

## Protocol boundary and automated seam

Koishi Sandbox uses its own adapter identity and does not faithfully reproduce QQ management-message IDs, QQ quote metadata, QQ forward-message delivery, or actual delivery to a QQ submitter. Those protocol-sensitive behaviors remain covered at deterministic automated seams:

- `tests/koishi-smoke.test.ts` verifies persisted management-message mapping, quoted authorization, claim/transfer/unclaim/progress/close/reopen actions, exactly one acceptance broadcast after the first claim, no second broadcast after a repeated/competing claim, and that arbitrary quoted text returns the fixed unknown-action response instead of relaying a reply.
- `plugins/memebot-intake/tests/notification.test.ts` uses a shared model seam to verify message mappings across service restart, delivery retry without duplicate summaries, a single conditional claim winner across competing service instances, explicit progress preservation across close/reopen, and marking the one-time acceptance notice only after successful delivery.

The real Sandbox route and the Mock seam are complementary: Sandbox proves the installed SQLite-backed user journey, while Mock supplies deterministic QQ protocol metadata and transport observation that Sandbox cannot represent.
