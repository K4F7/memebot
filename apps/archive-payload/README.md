# MemeBot Archive Payload

This is an independent PayloadCMS application. Production runs on Vercel as a Node.js/Next.js
project rooted at this directory, with Neon PostgreSQL for metadata and the existing private
Cloudflare R2 bucket for media. The Koishi `memebot-archive` plugin remains a read-only QQ adapter
and keeps the `/api/archive/v1` contract.

## Local development

Use Yarn from this directory:

```sh
corepack yarn install --immutable
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/memebot_archive corepack yarn dev
```

For local development, Payload uses `push` mode to keep PostgreSQL in sync. Production uses the
checked-in files in `src/migrations/`; an empty Neon database still needs the initial schema
migration before the first deployment.

To seed one local Admin account automatically, opt in explicitly and provide local-only
credentials. The seed runs only when `NODE_ENV=development`, never during a build or migration; it
is idempotent and does not overwrite an existing password:

```sh
PAYLOAD_DEV_ADMIN_SEED=1 \
PAYLOAD_DEV_ADMIN_EMAIL='dev@example.com' \
PAYLOAD_DEV_ADMIN_PASSWORD='local-development-password' \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/memebot_archive \
  corepack yarn dev
```

Keep these variables out of Vercel Production. The first account can still be created manually at
`/admin/create-first-user` when the development seed is disabled.

## Vercel project setup

Create or select the Vercel Project and connect the repository with Vercel Git Integration. Set the
Vercel Project Root Directory to `apps/archive-payload`; Vercel should use the Next.js framework
preset and deploy the production branch automatically.

The CLI link is optional for local inspection only:

```sh
cd apps/archive-payload
vercel link
```

The generated `.vercel/` directory is ignored and must not be committed. Vercel Git Integration is
the only production deployment entry point; GitHub Actions does not deploy this app.

Add the following values to the Vercel **Production** Environment. Manage them in the dashboard or
add them one at a time with `vercel env add`; do not commit an `.env` file or attempt to import a
complete secret file into Git.

```env
PAYLOAD_SECRET=replace-with-a-long-random-secret
DATABASE_URL=postgresql://user:password@ep-example-pooler.region.aws.neon.tech/memebot_archive?sslmode=require
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=memebot-archive
R2_REGION=auto
R2_ACCESS_KEY_ID=replace-with-r2-access-key-id
R2_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
ARCHIVE_SERVICE_TOKEN=replace-with-a-dedicated-machine-token
ARCHIVE_MEDIA_SIGNING_SECRET=replace-with-a-media-signing-secret
```

`DATABASE_URL` must be Neon’s pooled/runtime connection string. `DATABASE_MIGRATION_URL` is a
separate direct/unpooled Neon URL used only by the one-time/manual schema migration; it is never a
Vercel runtime variable.

After connecting the project, you can inspect the Vercel binding and environment without writing an
`.env` file:

```sh
vercel project inspect
vercel env ls production
```

Run a read-only Neon connectivity check locally with the pooled URL (keep the URL out of shell
history and logs):

```sh
DATABASE_URL='postgresql://…-pooler…?sslmode=require' \
  node --input-type=module -e '
    const { Client } = await import("pg")
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log((await client.query("select current_database(), now()")).rows[0])
    await client.end()
  '
```

The R2 bucket remains private. Configure bucket CORS for the Payload/Vercel Admin origins and
`PUT`/`GET` with the `Content-Type` and `Content-Length` headers used by direct uploads. The
custom Payload R2 adapter uses `clientUploads` so image/PDF bytes go directly from the Admin
browser to R2 instead of through Vercel's 4.5 MB Function body limit. The signer and Payload's
global upload limit both reject files over 100 MB before/at upload. Every Media record stores an
opaque `storageKey` such as `media/<uuid>`; display filenames are never used to identify R2
objects. The canonical Archive media endpoint keeps its HMAC check and redirects to a short-lived
R2 presigned GET URL, so Vercel does not proxy the media body. The separate authenticated Payload
Admin preview endpoint resolves the Media ID to the same presigned URL.

Preview deployments are build-only until a separate, isolated Neon/R2 environment is provisioned.
Do not copy Production credentials into Preview. Runtime smoke tests and Admin uploads are
Production-only for this rollout.

## GitHub Actions CI and initial schema

`.github/workflows/ci.yml` is the only automatic GitHub workflow for this app. On pull requests and
`main`, it runs typecheck, tests, and builds for the repository and Payload app. It does not call
Vercel, SSH, GHCR, or a VPS.

Before the first Vercel deployment, run the checked-in Payload schema migration once against Neon’s
direct/unpooled URL. The database is empty, so this is schema bootstrap rather than a data
migration. The migration command intentionally needs only `PAYLOAD_SECRET` and the direct
`DATABASE_MIGRATION_URL`:

```sh
PAYLOAD_SECRET='set-through-a-secret-manager' \
DATABASE_MIGRATION_URL='postgresql://…direct…?sslmode=require' \
  corepack yarn migrate
```

Do not put `DATABASE_MIGRATION_URL` in Vercel Runtime Environment. Vercel instances do not run
migrations during startup, and a deployment rollback does not downgrade the Neon schema. Because
this project currently has no production data, no data migration or legacy compatibility step is
part of the rollout.

## Legacy local container files

`Dockerfile` and `deploy/compose.yml` are retained for local or manual compatibility only. The old
VPS, SSH, GHCR, staging, and CLI deployment workflows have been retired; they are not a supported
release path.

## Commands

```sh
corepack yarn typecheck
corepack yarn test
corepack yarn build
corepack yarn payload migrate:create archive-postgres-change
```
