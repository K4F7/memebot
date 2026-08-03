# Activity Sandbox route verification

Issue: #37  
Date: 2026-08-03 (Asia/Shanghai)  
Base commit: `ad7065a3dadb9dc06b545924ec65228e120affe8`

## Environment

- Created an ignored, independent `app/` with the official `create-koishi` 6.4.0 scaffold and its own Yarn project.
- Loaded the five local plugins through `file:` dependencies.
- Ran Koishi 4.18.11 and Console Sandbox at `http://127.0.0.1:5146/sandbox`.
- Configured Alice with authority 4, Bob with the default member authority, and an Activity notification target that the Sandbox adapter could not deliver to.

## Observations

1. Alice completed `activity.add`, supplied every guided field, and explicitly chose `仅保存`. The reply said `活动创建成功；已仅保存，未请求通知。` and assigned stable identifier `#1`.
2. Bob ran `activity`. The upcoming `#1` record was listed. Bob then ran `activity #1` and received its full details.
3. Alice ran `activity.edit 1`, selected `标题，地点`, entered updated values, and explicitly chose `保存并通知`. The reply said `活动更新成功；记录已保存，但通知发送失败。` Bob's next `activity #1` query returned the updated title and location, proving notification failure did not roll back persistence.
4. Alice ran `activity.cancel 1` and explicitly chose `仅保存`. The reply independently reported the cancellation and the unrequested notification. `activity.history` included `#1` with `cancelled` status.
5. Bob's default `activity` list then reported no upcoming or active activities, while `activity #1` continued to return the cancelled record.
6. After stopping and restarting Koishi against the same SQLite database, Bob queried `activity #1` again. The updated, cancelled `#1` record remained available.
7. The browser reported zero console errors during the completed flow. The remaining warnings came from the Console router while its asynchronous page components loaded.

The Console Sandbox cannot prove delivery through a real QQ adapter. Successful delivery is therefore covered by the Koishi Mock integration test, which registers `qq:30001`, captures exactly one broadcast for the edit, and verifies its Activity details. Unit coverage separately exercises thrown delivery errors and missing notification targets.

## Commands

```text
yarn smoke:local-app
yarn vitest run plugins/memebot-activity/tests/activity.test.ts tests/koishi-smoke.test.ts
yarn typecheck
yarn build
cd app && yarn start
```
