# Archive Console browser acceptance

The Archive browser suite drives a real Koishi Console and records unavailable capabilities as **NOT EXECUTED**, never as a passing browser assertion.

## Required local run

Start the independent `/app` Koishi project, then run from the repository root:

```powershell
$env:MEMEBOT_ARCHIVE_WEBUI_URL = 'http://127.0.0.1:5140'
yarn workspace koishi-plugin-memebot-archive test:browser:required
```

POSIX shells can run the equivalent command inline:

```sh
MEMEBOT_ARCHIVE_WEBUI_URL=http://127.0.0.1:5140 yarn workspace koishi-plugin-memebot-archive test:browser:required
```

The required command fails if the URL or Playwright Chromium is unavailable. The regular `test:browser` command exits successfully after printing `NOT EXECUTED` when browser execution is optional and unavailable.

Playwright screenshots, traces, downloads, and generated ZIP fixtures are written under `output/playwright/archive/`.

## Capability flags

- `MEMEBOT_ARCHIVE_AUTH_MODE=absent` (default) executes the open local Console path.
- `MEMEBOT_ARCHIVE_AUTH_MODE=installed` plus `MEMEBOT_ARCHIVE_AUTH_STORAGE_STATE=<path>` executes the pre-authenticated Auth/Login path. Without the storage state it is reported as not executed.
- `MEMEBOT_ARCHIVE_BACKUP_RETRY=available` executes retry against a prepared failed R2 backup job. Without that fixture the capability is reported as not executed.
- `MEMEBOT_ARCHIVE_R2_RECOVERY=available` executes recovery preview against prepared R2 manifests. Without manifests the capability is reported as not executed.

The default local app has Auth/Login and R2 disabled, so the absent-auth path runs while installed-auth, backup retry, and recovery preview remain explicit skipped capabilities. Light and dark themes, responsive cards, URL history/refresh, keyboard paths, focus restoration, Issue/Work uploads, safe Work preview, Publication Appearance, removal, and restoration all execute locally.
