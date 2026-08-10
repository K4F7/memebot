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
Payload's `clientUploads` option sends Admin uploads directly to R2, avoiding Vercel Function body
limits. The canonical Archive media endpoint retains its HMAC check and redirects to a short-lived
R2 presigned GET URL, so Vercel does not proxy complete media bodies. The R2 bucket stays private
and must allow the Payload/Vercel origins in its CORS policy for direct uploads.

The old VPS, SSH, GHCR, staging, and Vercel CLI deployment workflows are retired. Docker/Compose
files remain only as legacy local or manual compatibility artifacts and are not part of the
production release path.
