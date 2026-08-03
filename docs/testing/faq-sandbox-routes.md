# FAQ Sandbox route verification

Issue: #38  
Date: 2026-08-03 (Asia/Shanghai)  
Base commit: `a166100427fbeaa555c397e3c977b3ce84abb0eb`

## Environment

- Created an ignored, independent `app/` with the official `create-koishi` 6.4.0 scaffold and its own Yarn project.
- Loaded Access and all four business plugins through local `file:` dependencies.
- Ran Koishi 4.18.11 and Console Sandbox at `http://127.0.0.1:5147/sandbox` with FAQ page size 1.
- Used Alice with authority 4 as Plugin Administrator and Bob with the default member authority.

## Observations

1. Alice completed two guided `faq.add` flows, reviewed each preview, explicitly sent `确认`, and received stable references `#1` and `#2`.
2. Bob used `faq` and `faq 2` to browse both public pages, then used `faq #1` to retrieve the complete Question and Answer.
3. Bob attempted `faq.add` and received the observable identity denial `你不是管理员。`.
4. Alice used `faq.edit #1`, selected `两者`, changed the Question and Answer, confirmed the preview, and observed the updated detail.
5. Alice attempted `faq.rm #1` while the entry was public and received `请先隐藏 FAQ，再永久删除。`.
6. Alice confirmed `faq.hide #1`; Bob's subsequent `faq #1` returned `FAQ 编号不存在。`. Alice then confirmed `faq.show #1`, making the entry public again, and hid it once more before removal.
7. Alice opened the permanent removal preview but sent `取消`. The reply was `已取消永久删除。` and the entry remained present.
8. After stopping and restarting Koishi against the same SQLite database, `faq.manage` still showed `#1` as hidden and `#2` as public, preserving identifiers, edited content, and visibility.
9. Alice then ran `faq.rm #1`, explicitly sent `确认`, and received `已永久删除 FAQ #1。`. The next management list contained only public `#2`.
10. The browser reported zero console errors during the completed route. Remaining warnings came from the Console router while asynchronous page components loaded.

The Koishi Mock integration test mirrors this route without relying on browser-local conversation history. It verifies public pagination and numbered answers, ordinary-member denial, edit persistence, hide/show visibility, hide-before-remove, cancellation safety, explicit permanent-removal confirmation, and the final persistent state.

## Restart persistence procedure

The restart check used the scaffold's SQLite file at `app/data/koishi.db`:

1. After the cancelled removal, a fresh `faq.manage` request returned `1. [隐藏] 怎样投稿？` and `2. [公开] 如何反馈？`.
2. Koishi was stopped, without deleting or replacing `app/data/koishi.db`, and started again with `cd app && yarn start`.
3. After the Console reconnected, a new `faq.manage` request returned the same two records, identifiers, edited Question, and visibility states.
4. Only then was `faq.rm #1` run again and confirmed. A subsequent new `faq.manage` request returned only `2. [公开] 如何反馈？`.

The messages visible after a Console reconnect include browser-local Sandbox history, so the persistence conclusion relies on the new command replies in steps 3 and 4, not on old messages being rendered again.

## Commands

```text
yarn smoke:local-app
yarn vitest run plugins/memebot-faq/tests/faq.test.ts tests/koishi-smoke.test.ts
yarn typecheck
yarn build
cd app && yarn start
```
