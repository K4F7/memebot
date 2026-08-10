# Archive Vercel deployment acceptance

The production Payload project is deployed from `apps/archive-payload` through Vercel Git
Integration. GitHub Actions only runs repository CI; it does not deploy Vercel artifacts.

## One-time setup

In the Vercel dashboard, connect the repository and set the Project Root Directory to
`apps/archive-payload`. The CLI link is optional for local inspection:

```sh
cd apps/archive-payload
vercel link
```

Do not commit `.vercel/`. Add the runtime variables listed in the app [README](../../apps/archive-payload/README.md)
to the Vercel Production Environment. `DATABASE_URL` is Neon’s pooled connection;
`DATABASE_MIGRATION_URL` is a direct/unpooled connection used only by the manual migration command
and is never a Vercel Runtime variable.

## Deployment and schema sequence

For a production branch push, GitHub Actions and Vercel Git Integration run from the same commit
as independent paths. Protect `main` with the CI checks if the repository should require them before
merge; Vercel Git Integration remains the production deployment entry point:

```text
GitHub push -> CI (typecheck + test + build)
            -> Vercel Git Integration build -> production deployment
```

Run the initial schema migration separately before the first production request, using the direct
Neon URL. An empty Neon database still needs this bootstrap; it is not an old-record data migration:

```sh
cd apps/archive-payload
PAYLOAD_SECRET='set-through-a-secret-manager' \
DATABASE_MIGRATION_URL='postgresql://…direct…?sslmode=require' \
  corepack yarn migrate
```

Vercel request-serving instances never run migrations, and deployment rollback does not reverse a
schema change.

## Smoke checks

After deployment, run the existing deterministic checks and the Archive staging smoke against a
protected Vercel Preview or production URL when credentials are available:

```sh
corepack yarn typecheck
corepack yarn build
corepack yarn test
MEMEBOT_ARCHIVE_STAGING_URL=https://archive.example \
MEMEBOT_ARCHIVE_STAGING_TOKEN='set-through-a-secret-manager' \
corepack yarn smoke:archive-staging
```

The smoke must verify health, machine-authenticated Work search/detail, HMAC media access, expired
signatures, private direct R2 access, and Koishi merged-forward delivery. For the Admin path, also
verify that image/PDF uploads use the Payload signed PUT URL and that a media request follows the
HMAC endpoint redirect to an R2 presigned GET URL.
