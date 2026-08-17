# Independent CMS Repository and CI/CD Contract

Date: 2026-08-17

## Question

What name, layout, and environment boundary should the independent content-platform repository use, and how should Vercel Admin and the VPS Strapi API be built, verified, deployed, health-checked, versioned, secret-managed, and rolled back?

## Finding

Create `K4F7/cms` as a single Strapi 5 application. Every push to `main` deploys both ends: Vercel Git Integration publishes Admin; GitHub Actions publishes `ghcr.io/k4f7/cms:<git-sha>` and an HMAC webhook updates the VPS. GitHub Secrets are the secret source. The VPS never builds images and never accepts SSH as a deploy trigger.

```text
main push
  ├─ Vercel Git Integration → Admin production
  └─ GitHub Actions (production Environment)
        ├─ verify + build image
        ├─ push ghcr.io/k4f7/cms:<git-sha>
        └─ HMAC webhook → louis
              ├─ write deploy/.env from GitHub Secrets
              ├─ compose pull && up --no-build
              ├─ health check
              └─ keep current + previous successful images
```

## Contract

- **Repository:** `K4F7/cms`. Standard Strapi 5 tree (`config/`, `src/`) plus `deploy/compose.yml`. Do not split `apps/admin` and `apps/api`.
- **Image:** `ghcr.io/k4f7/cms:<git-sha>`.
- **Daily trigger:** every `main` push deploys both Admin and API. Do not path-filter the API away from Admin-only commits.
- **Tags:** optional named rollback snapshots, not the daily switch.
- **Secrets:** GitHub Environment `production` is authoritative, including the database password. The tag-or-push workflow injects runtime secrets into VPS `deploy/.env` (not committed). Vercel holds only the public API URL. Actions runners do not connect to loopback PostgreSQL.
- **Webhook:** HTTPS POST, HMAC-SHA256 over the raw body plus a timestamp. OpenResty returns 401 on a bad signature. Access logs must not record the body.
- **Success:** after `compose up`, poll the Strapi health endpoint. Only a timely success returns HTTP 200 with sha and digest. Actions fails on any other response.
- **Rollback:** Admin uses the previous Vercel deployment. API re-invokes the webhook with the previous successful image. A failed health check does not auto-rollback (migrations may already have run).
- **Disk:** after a successful health check, delete local `ghcr.io/k4f7/cms` images other than the running image and the previous success, plus dangling layers. Do not prune on failure. Do not delete GHCR history.
- **Out of band:** SSH and Watchtower are not Strapi deploy triggers. The VPS does not build. Do not add a second PostgreSQL or a self-hosted runner.

## Decision input

This contract, with the VPS facts in #63, is enough to implement the first `cms` repository workflows and the louis webhook. Remaining topology choices (API hostname, upload limit versus the 50 MiB OpenResty cap, on-box versus off-box backup) stay on #64.
