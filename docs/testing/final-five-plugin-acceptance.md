# Historical final five-plugin acceptance record

> Historical record for the pre-Archive-v2 Koishi management boundary. The Archive results below
> are retained for provenance only; current Archive management and verification follow
> `docs/testing/archive-console-browser.md` and `docs/testing/archive-qq-shortcuts.md`.

Issue: #42  
Date: 2026-08-03 (Asia/Shanghai)  
Base commit: `599d461f279c89a3d2d77ee92d39c2103afcc146`

## Result

The final acceptance status is **PASSED** for every check available in the local deployment. Checks that require an installed Auth/Login deployment, prepared R2 failure/recovery fixtures, or real R2 credentials are **NOT EXECUTED** and are not counted as passing checks. No check finished with a **FAILED** status.

## Environment

- Windows, Node.js `v24.18.0`, Yarn `4.5.3`, Koishi `4.18.11`.
- Used an ignored, independent `app/` Yarn project on `http://127.0.0.1:5151` with its own lockfile and SQLite database.
- Loaded `memebot-access` plus Intake, FAQ, Activity, and Archive from local `file:../plugins/memebot-*` dependencies. The Access resolution was also fixed to its local `file:` package.
- Enabled Server, Console, Sandbox, SQLite, Access, and all four business plugins in the same deployment.
- Configured non-secret placeholder Intake notification targets so the Sandbox adapter could exercise persistence independently from unavailable QQ delivery.

## Repository gates

| Check | Status | Evidence |
| --- | --- | --- |
| `yarn install --immutable` | PASSED | Yarn completed with only its existing peer-dependency warning. |
| `yarn typecheck` | PASSED | All workspaces and the repository test project passed. |
| `yarn build` | PASSED | All five independently publishable plugins built. |
| `yarn test` | PASSED | 23 files and 141 tests passed; the one real-R2 integration test was skipped. |
| `yarn check:plugin-loads` | PASSED | Printed `Loaded 5 Koishi plugin entries successfully.` |
| Access package tests | PASSED | 9 tests passed. |
| Intake package tests | PASSED | 18 tests passed. |
| FAQ package tests | PASSED | 5 tests passed. |
| Activity package tests | PASSED | 6 tests passed. |
| Archive package tests | PASSED | 70 tests passed; the one real-R2 integration test was skipped. |
| `yarn smoke:local-app` | PASSED | Console responded, all five plugin apply lines were present, and the process remained healthy through the settle period. |

The local startup log contained warnings from the optional Koishi Market scanner (`TypeError: this is not a function` followed by `Not Found`). It also reported `broadcast channel not found: qq:10001` while retrying the deliberately unreachable test-only Intake target. These warnings did not prevent Console startup and did not produce a smoke-check startup failure. The missing broadcast channel is the expected observable transport limitation for the persistence-only Sandbox route. A reproducer should retain these visible warnings when diagnosing a future environment difference rather than silently discarding them.

## Sandbox routes

The four routes were exercised in headless Chromium against the same port-5151 deployment with the committed `test:sandbox` command. Playwright reported `1 passed (9.2s)`:

1. Activity: the authority-4 user completed `activity.add`, supplied every guided field, chose exact `仅保存`, received `活动创建成功`, and found the new record through `activity`.
2. FAQ: an authority-4 Sandbox user completed `faq.add`, supplied a Question and Answer, reviewed the preview, sent exact `确认`, and received `FAQ 新增成功`.
3. Archive: the same administrator used `archive.issue-publish` with valid JSON and a base64 PDF data URL, received a stable Newspaper Issue identifier, then found `Final acceptance` through `archive.search paper`.
4. Intake: `feedback` opened collection, a separate text message produced the collected-item acknowledgement, and exact `提交` persisted a stable `反馈#N`. Delivery to the placeholder QQ target was unavailable in Sandbox without rolling back persistence.

For Intake and Activity, “route complete” means the user/admin mutation was persisted and its visible success-or-delayed-delivery result was returned. The Sandbox adapter cannot prove real QQ delivery; the successful and failed transport outcomes remain covered by the deterministic Mock seams described in the route documents.

The complete route matrices, including cancellation, denial, edit, visibility, lifecycle, restart, and QQ protocol boundary observations, remain reproducible in:

- `docs/testing/intake-sandbox-route.md`
- `docs/testing/activity-sandbox-routes.md`
- `docs/testing/faq-sandbox-routes.md`
- `docs/testing/archive-qq-shortcuts.md`

The deterministic cross-plugin route seam also passed as part of `tests/koishi-smoke.test.ts` in the 141-test repository run. The first interactive Chrome attempt had the KISS Translator extension injected and did not reliably expose Koishi reply nodes to the automation snapshot. The no-extension Playwright Chromium immediately returned the expected reply and was used for the recorded browser result.

## Archive browser

With `MEMEBOT_ARCHIVE_WEBUI_URL=http://127.0.0.1:5151`, the required Archive Playwright command executed against the same deployment:

- PASSED: complete local Archive management surface.
- PASSED: desktop, 767 px, and 390 px responsive layouts plus horizontal containment.
- PASSED: `activity:archive`, light/dark theme, and Auth/Login-absent route.
- NOT EXECUTED: Auth/Login-installed mode because Auth/Login and authenticated storage state were unavailable.
- NOT EXECUTED: failed Archive Backup retry because no failed R2 backup fixture was prepared.
- NOT EXECUTED: R2 recovery preview because no R2 manifests were available.

The Playwright summary was `3 passed, 3 skipped`. The runner printed every unavailable capability as `NOT EXECUTED` before the suite; none was represented as a passing assertion.

## Real R2 boundary

The default repository and browser tests used local or in-memory stores and did not access real R2. Presence-only checks reported all four deployment variables as `UNSET` without reading or printing any value:

```text
MEMEBOT_R2_ACCOUNT_ID=UNSET
MEMEBOT_R2_BUCKET_NAME=UNSET
MEMEBOT_R2_ACCESS_KEY_ID=UNSET
MEMEBOT_R2_SECRET_ACCESS_KEY=UNSET
```

Real R2 verification status: **NOT EXECUTED**. `plugins/memebot-archive/tests/r2.integration.test.ts` runs only when all four variables are present; otherwise Vitest skips it. When a dedicated deployment environment is available, inject the values outside the repository and run only:

```sh
yarn vitest run plugins/memebot-archive/tests/r2.integration.test.ts
```

Do not include credential values in commands, reports, screenshots, or logs.

## Reproduction

Run the repository gates from the repository root:

```sh
yarn install --immutable
yarn typecheck
yarn build
yarn test
yarn check:plugin-loads
yarn workspace koishi-plugin-memebot-access test
yarn workspace koishi-plugin-memebot-intake test
yarn workspace koishi-plugin-memebot-faq test
yarn workspace koishi-plugin-memebot-activity test
yarn workspace koishi-plugin-memebot-archive test
```

Build before installing the ignored app so its `file:` dependencies snapshot current plugin output. To exercise Intake, configure a non-secret test-only target in the ignored app; a minimal example is:

```yaml
memebot-intake:
  targets:
    feedback:
      users:
        - qq: "10001"
```

Start the app with `cd app && yarn start`, then run from a second terminal:

```powershell
yarn smoke:local-app
$env:MEMEBOT_ARCHIVE_WEBUI_URL = 'http://127.0.0.1:5151'
yarn workspace koishi-plugin-memebot-archive test:sandbox
yarn workspace koishi-plugin-memebot-archive test:browser:required
```

On failure, retain the failing command, exit code, Playwright scenario name, visible Koishi reply or error text, `app/` startup log, and the generated screenshot/trace path under `output/playwright/archive/`. Report unavailable prerequisites as **NOT EXECUTED**; do not convert them into passed checks.
