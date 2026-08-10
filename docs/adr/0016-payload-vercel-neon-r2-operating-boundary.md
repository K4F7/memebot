---
status: accepted
---
# Run Payload on Vercel with Neon and private R2

The Archive Payload application runs as a Node.js/Next.js project on Vercel. The Vercel project
root is `apps/archive-payload`, and Vercel Git Integration automatically deploys the connected
production branch. GitHub Actions is restricted to repository CI (typecheck, test, and build) and
does not deploy the application.

Payload keeps the PostgreSQL adapter. Runtime requests use a Neon pooled `DATABASE_URL`. The empty
production database still requires the checked-in Payload schema migration, which is run once (or
manually when new migrations are added) with a separate direct/unpooled `DATABASE_MIGRATION_URL`.
That URL is not a Vercel Runtime Environment variable. No legacy data migration or data
compatibility layer is required. Vercel instances never run migrations during startup, and a
deployment rollback never downgrades the database schema.

Media bytes remain in the existing private Cloudflare R2 bucket through the S3-compatible API.
The application uses Payload's cloud-storage adapter seam with a custom client upload handler:
the server signs a random opaque `media/<uuid>` key, the Admin browser PUTs directly to R2, and the
signed context is validated before Payload persists the Media record. The collection's persisted
`storageKey` is the only object identity; display filenames may repeat and are never reconstructed
into R2 keys. Payload's global upload limit and the signer enforce the MVP's 100 MB limit. The
canonical Archive media endpoint retains its HMAC check and redirects to a short-lived R2 presigned
GET URL, so Vercel does not proxy complete media bodies. The authenticated Payload Admin preview
endpoint resolves a Media ID to the same key and presigned URL. The R2 bucket stays private and
must allow the Payload/Vercel origins in its CORS policy for direct uploads.

Preview deployments are build-only until an isolated Neon/R2 environment is configured; Production
is the only runtime smoke target for the initial rollout. The old VPS, SSH, GHCR, staging, and
Vercel CLI deployment workflows are retired. Docker/Compose files remain only as legacy local or
manual compatibility artifacts and are not part of the production release path.
