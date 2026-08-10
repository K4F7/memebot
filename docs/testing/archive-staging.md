# Archive staging acceptance

This is the operator runbook for issue #52. The default repository checks remain deterministic and
credential-free; the real check is an explicit black-box run against an isolated Archive staging
service.

## Current deployment boundary

The accepted Archive v2 deployment decision is a normal Node.js/Next.js Payload service on the VPS,
backed by a dedicated PostgreSQL database and a private Cloudflare R2 bucket through the S3 API
([ADR 0014](../adr/0014-payload-vps-operating-boundary.md)). The Koishi plugin is an independent
machine-authenticated read adapter. The earlier OpenNext Workers + D1 + R2 experiment was removed
because the Payload bundle exceeded the Workers script-size limit; no Wrangler or D1 deployment is
present on the current branch.

Do not restore the deleted Workers/D1 configuration as part of an acceptance run. If the deployment
target must become Workers + D1 again, record a new architecture decision and implement a separate
Payload runtime before changing this runbook. The staging checks below prove the currently accepted
VPS + PostgreSQL + private-R2 contract, including the Cloudflare R2 boundary.

## Run the black-box smoke

Build the plugin first when the real Koishi adapter check is enabled:

```sh
corepack yarn install --immutable
corepack yarn build
```

Provide values through the shell, a protected environment, or a local file that is never committed.
The runner never prints token values or request headers:

```sh
export MEMEBOT_ARCHIVE_STAGING_URL='https://archive-staging.example'
export MEMEBOT_ARCHIVE_STAGING_TOKEN='set-this-through-your-secret-manager'
export MEMEBOT_ARCHIVE_STAGING_WORK_ID='W1'
export MEMEBOT_ARCHIVE_STAGING_KOISHI=1
corepack yarn smoke:archive-staging
```

`MEMEBOT_ARCHIVE_STAGING_URL` accepts either the site root or
`/api/archive/v1`. A run without both URL and token is `NOT EXECUTED` and exits successfully so
normal CI remains safe. Set `MEMEBOT_ARCHIVE_STAGING_REQUIRED=1` (or pass `--required`) when a
missing configuration must fail a protected staging job.

The runner checks:

| Check | Observable result |
| --- | --- |
| `health` | Payload and authenticated R2 health endpoint returns `{ status: "ok" }`. |
| `invalid-credential` | A deliberately wrong machine token receives 401/403. |
| `machine-read` / `work-detail` | The configured `W<n>` is searchable through the canonical versioned API and returns ordered Media. |
| `private-media` | A same-origin signed URL returns non-empty bytes; an existing object's direct R2 URL returns 401/403. |
| `expired-media` | The same URL with an expired timestamp receives 401/403. |
| `koishi-client` | With `MEMEBOT_ARCHIVE_STAGING_KOISHI=1`, the built `memebot-archive` adapter rejects a wrong token as `unauthorized`, then searches, retrieves, fetches Media, and builds the merged-forward message(s) through the same boundary. |
| `redeploy-persistence` | A saved baseline or `MEMEBOT_ARCHIVE_STAGING_AFTER_URL` has the same Work and Media order after a restart/redeploy. |
| `payload-outage` | An explicitly supplied stopped/isolated endpoint fails as an unavailable boundary. |
| `failed-media` | An explicitly supplied signed URL whose object was removed returns non-2xx without hiding the Work. |

Optional Admin bootstrap creates a uniquely titled Work, uploads two tiny PNGs to the private bucket,
and creates ordered WorkMedia relationships through Payload's authenticated API. It intentionally
leaves the fixture in staging so the operator can verify persistence and, after removing one object,
the failed-media behavior:

```sh
export MEMEBOT_ARCHIVE_STAGING_CREATE_FIXTURE=1
export MEMEBOT_ARCHIVE_STAGING_ADMIN_EMAIL='staging-admin@example.invalid'
export MEMEBOT_ARCHIVE_STAGING_ADMIN_PASSWORD='set-this-through-your-secret-manager'
unset MEMEBOT_ARCHIVE_STAGING_WORK_ID
corepack yarn smoke:archive-staging
```

Use a dedicated staging administrator, never a production account. Without the opt-in flag, the
Admin step is reported as `NOT EXECUTED` and the runner uses the manually recorded `W<n>` fixture.

### Redeploy/restart persistence

For a two-pass check, set a state file on the first run. The first run records only the Work id and
ordered Media ids; it never writes credentials. Restart or redeploy the same staging service, then
run the command again with the same state file and `MEMEBOT_ARCHIVE_STAGING_WORK_ID`:

```sh
export MEMEBOT_ARCHIVE_STAGING_STATE_FILE="$PWD/.archive-staging-state.json"
corepack yarn smoke:archive-staging       # records the baseline
# deploy/restart the isolated service here
corepack yarn smoke:archive-staging       # compares the saved Work and Media order
rm -f "$MEMEBOT_ARCHIVE_STAGING_STATE_FILE"
```

For a replacement staging hostname, set `MEMEBOT_ARCHIVE_STAGING_AFTER_URL` on a run that has
already read the baseline Work. Keep the state file and smoke output with the operator record, but
never commit either one.

## Manual failure fixtures

The normal API/adapter tests already cover the user-facing translations. The real run may add these
fixtures without changing production data:

1. Stop or isolate the staging Payload service and set `MEMEBOT_ARCHIVE_STAGING_OUTAGE_URL` to its
   URL. The check must observe a connection failure or HTTP 5xx.
2. Delete only the R2 object for one retained Media record (do not delete the Payload record), copy
   its signed URL from a fresh Work detail response, and set
   `MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_URL` plus its `MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_WORK_ID`.
   The Work must still list and deliver its other
   Media items. The full Koishi check requires at least two Media items, exactly one failed fetch,
   and a merged-forward node containing the per-item failure message.
3. Run the smoke with a wrong `MEMEBOT_ARCHIVE_STAGING_TOKEN`; this is automated and must remain
   401/403.

The Koishi user-facing expectations are:

- Payload outage or malformed/unavailable responses: `Archive 服务暂时不可用，请稍后重试。`
- Invalid machine credential: `Archive 机器凭证无效。`
- Expired or failed individual Media: the item reports `<filename> 获取失败。`; other items remain
  in the merged-forward delivery.

## Protected staging deployment

`.github/workflows/deploy-archive-payload-staging.yml` is manual (`workflow_dispatch`) and uses a
protected GitHub `staging` Environment. It builds and pushes an immutable image, copies the existing
rollback-aware `deploy.sh` and Compose file to an isolated application directory, injects the
runtime `.env` over SSH with mode `0600`, activates the image digest, and runs the smoke before and
after deployment using a temporary state file. The `exercise_rollback` input (enabled by default)
deliberately references a missing image, asserts that `deploy.sh` fails, and then probes the restored
image's health endpoint. Normal push/PR CI never runs this workflow and never receives its secrets.

The default Admin-bootstrap run creates the two-media fixture and persists it across the deployment.
The failed-object fixture is a separate pre-created Work because deleting an R2 object is an
operator-only destructive action; both Work ids are checked in the same run.

Configure the Environment with these values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `STAGING_VPS_HOST`, `STAGING_VPS_PORT`, `STAGING_VPS_USER`, `STAGING_VPS_APP_DIR` | Isolated host and application directory. |
| Variable | `STAGING_ARCHIVE_URL` | Public HTTPS site root used by the smoke. |
| Variable | `STAGING_ARCHIVE_WORK_ID` | Existing fixture id when Admin bootstrap is not requested. |
| Variable | `STAGING_ARCHIVE_FAILURE_WORK_ID` | Pre-created Work id containing exactly one retained-but-missing R2 object. |
| Variable | `STAGING_ARCHIVE_DIRECT_MEDIA_URL` | Anonymous direct object URL used to prove the R2 bucket is private. |
| Secret | `STAGING_VPS_SSH_KEY`, `STAGING_VPS_KNOWN_HOSTS` | Deployment-only SSH identity and verified host key. |
| Secret | `STAGING_GHCR_USERNAME`, `STAGING_GHCR_READ_TOKEN` | Read-only GHCR pull identity on the staging host. |
| Secret | `STAGING_ARCHIVE_ENV_FILE` | Complete staging Payload `.env` (PostgreSQL, private R2 S3, Payload, service-token, and signing-secret values). |
| Secret | `STAGING_ARCHIVE_SERVICE_TOKEN` | Machine credential supplied only to the smoke job. |
| Secret | `STAGING_ARCHIVE_MEDIA_SIGNING_SECRET` | Staging signing secret used to mint a correctly signed expired URL. |
| Secret | `STAGING_ARCHIVE_ADMIN_EMAIL`, `STAGING_ARCHIVE_ADMIN_PASSWORD` | Dedicated staging Admin fixture credentials when the default `create_fixture` input is enabled. |

`STAGING_ARCHIVE_ENV_FILE` is streamed to the host and is not echoed by the workflow. It must use a
dedicated PostgreSQL database, private R2 bucket, and credentials that cannot access production.
Never put this file, a service token, or an Admin password in Git. The R2 bucket must have no public
read policy; the only public URL is the Payload signed-media endpoint.

The remote `deploy.sh` records the previous image and restores it when the new health check fails.
It does not roll back PostgreSQL migrations. Before a staging migration test, retain a database dump
and ensure the previous image remains compatible with the migrated schema, matching the production
operating decision.

## Operator record

Attach the following to the staging issue or deployment record without secret values:

- commit SHA and image digest;
- staging host/application directory and deployment timestamp;
- whether the Admin fixture, Koishi adapter, outage, failed-media, and redeploy checks were executed;
- the complete smoke report, with `NOT EXECUTED` prerequisites preserved as such;
- secret injection method and rollback result;
- PostgreSQL/R2/1Panel limitations and any manual QQ transport limitation.

The deterministic repository checks remain the merge gate:

```sh
corepack yarn typecheck
corepack yarn build
corepack yarn test
```
