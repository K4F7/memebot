# MemeBot Archive Payload

This is an independent PayloadCMS application. It runs as a normal Node.js/Next.js service on
the VPS. The Docker Compose file starts only Payload; it does not create PostgreSQL or any other
database container.

## Local development

Use Yarn from this directory:

```sh
corepack yarn install
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/memebot_archive corepack yarn dev
```

For development, `push` mode keeps a local PostgreSQL schema in sync. Production uses the checked
in migration in `src/migrations/` and applies pending migrations during Payload startup.

## Runtime services

The application requires a PostgreSQL database. On the production VPS, set `DATABASE_URL` to the
existing PostgreSQL instance. With the current 1Panel Docker network, the host is typically
`postgresql` and the URL has this shape:

```text
postgres://<user>:<password>@postgresql:5432/<database>
```

The application does not create that database. Create the database and user once using the VPS's
existing PostgreSQL administration workflow. Do not put the password in Git or in a GitHub Actions
log.

The public service name is `https://meme.sein.moe`. Configure 1Panel's reverse proxy to forward it
to `http://127.0.0.1:13000`; TLS and Nginx configuration are intentionally outside this repository.
The container continues to listen on port `3000` internally.

Media files remain in a private Cloudflare R2 bucket through its S3-compatible API. Payload uses
`@payloadcms/storage-s3`, which is the Node.js-compatible R2 integration. The API returns short-lived
signed media URLs; the bucket is not made public.

Required production variables in the VPS-only `deploy/.env` file are:

```env
PAYLOAD_SECRET=replace-with-a-long-random-secret
DATABASE_URL=postgres://user:password@postgresql:5432/memebot_archive
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET=memebot-archive
R2_REGION=auto
R2_ACCESS_KEY_ID=replace-with-r2-access-key-id
R2_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
ARCHIVE_SERVICE_TOKEN=replace-with-a-dedicated-machine-token
ARCHIVE_MEDIA_SIGNING_SECRET=replace-with-a-media-signing-secret
```

## VPS deployment

The server needs Docker Compose, access to the existing PostgreSQL Docker network, and a private
GHCR login with a token that has only `read:packages`. Create the application directory and place
the environment file there:

```sh
mkdir -p /srv/memebot/archive-payload
chmod 700 /srv/memebot/archive-payload
chmod 600 /srv/memebot/archive-payload/.env
```

Before approving a production deployment that includes a database migration, take the required
PostgreSQL dump. Payload applies the checked-in migration during startup after approval; an image
rollback never downgrades the database schema, so the previous image must remain compatible with
the migrated schema.

The deployment script keeps the previous image reference and restores it if the health check fails.
The health endpoint is `GET /api/health` and is reachable locally at
`http://127.0.0.1:13000/api/health`.

The workflow is `.github/workflows/deploy-archive-payload-vps.yml`. Create a GitHub `production`
Environment with required approval, then configure:

```text
Secrets:  VPS_SSH_KEY, VPS_KNOWN_HOSTS, GHCR_USERNAME, GHCR_READ_TOKEN
Variables: VPS_HOST, VPS_PORT, VPS_USER, VPS_APP_DIR
```

`VPS_KNOWN_HOSTS` must contain the verified SSH host key, not the output of an unverified
`ssh-keyscan`. The workflow pins its third-party actions to commit SHAs, builds an immutable image
tagged with the commit SHA, records the registry digest, pushes it to GHCR, uploads the Compose
files, logs the VPS into GHCR with the read-only token, and activates the digest over SSH. It does
not provision a database.

## Commands

```sh
corepack yarn typecheck
corepack yarn test
corepack yarn build
corepack yarn payload migrate:create archive-postgres-change
```

For production, run migrations through the application startup path and back up PostgreSQL before
deploying schema changes. Do not automatically downgrade migrations during an application rollback.
