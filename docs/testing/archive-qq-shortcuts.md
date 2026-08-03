# Archive QQ shortcut verification

Issue: #39  
Date: 2026-08-03 (Asia/Shanghai)  
Base commit: `62438ad1788d61d39702938b0ded2c85b78fa1a9`

## Environment

- Created an ignored, independent `app/` with the official `create-koishi` 6.4.0 scaffold and its own Yarn project.
- Loaded Access and all four business plugins through local `file:` dependencies.
- Ran Koishi 4.18.11 and Console Sandbox at `http://127.0.0.1:5148/sandbox` with SQLite and the local Archive attachment store.
- Used Alice with authority 4 as Plugin Administrator and Bob with the default member authority.

## Observations

1. Alice used the compact `archive.issue-publish` and `archive.work-publish` routes with base64 data-URL attachments. The replies assigned `P1` and `W1`; the PDF and ZIP were decoded, validated, and written to the authoritative local attachment store.
2. Alice used `archive.issue-edit` and `archive.work-edit` with exact `Y` confirmation. Public searches immediately returned the revised Paper and Work titles.
3. Alice used `archive.retry` and received `已重试待同步附件。`. Bob attempted the same protected shortcut and received `你不是管理员。`.
4. Bob used `archive.search paper`, `archive.search works`, `archive P1`, and `archive W1`. Search and detail replies were public and used stable Archive Identifiers.
5. The Console Sandbox rendered each returned file element as a separate empty Koishi message. Therefore attachment filename and byte authority are asserted in the Koishi Mock route test, which verifies `august.pdf` and `work.zip` after service recovery from the local store.
6. Alice ran `archive.rm W1`, saw the exact Work target and 30-day recovery warning, and sent `确认`. The reply was `已移除 Work W1，保留 30 天。`; Bob then received `Work 不存在。`.
7. After stopping and restarting Koishi against the same SQLite database and local attachment directory, a new `archive P1` request returned the revised Paper and its file message, while a new `archive W1` request still returned `Work 不存在。`.
8. The browser reported zero console errors during the completed route. Remaining warnings came from the Console router while asynchronous page components loaded.

The Mock integration suite also verifies the Access Management Group denial for administrator writes in an unlisted group, administrator-only metadata preview, QQ-style identifiers and quotes, and forward-message fallback to ordinary delivery.

## Scope boundary

These QQ commands are compact shortcuts only. They do not cover R2 restore preview/application, restore history, lifecycle audit, permanent purge or anonymization, Work preview/file-tree safety, or complete Publication Appearance management. Those remain responsibilities of the Archive Console UI and its deterministic service/Console tests. `archive.retry` retries pending Archive Backup jobs; it is not an R2 recovery command.

## Commands

```text
yarn smoke:local-app
yarn vitest run tests/koishi-smoke.test.ts plugins/memebot-archive/tests/index.test.ts
yarn typecheck
yarn build
cd app && yarn start
```
