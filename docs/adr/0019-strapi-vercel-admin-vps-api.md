---
status: accepted
---
# Run Strapi Admin on Vercel and the API on the VPS

Archive administration moves to an independent `K4F7/cms` Strapi 5 application.
Vercel hosts only the prebuilt Admin. VPS `louis` hosts the API,
authentication, the local upload provider, and a host bind-mounted media
directory behind OpenResty. The API reuses the existing 1Panel PostgreSQL
instance with a dedicated database and user.

The split is the supported first-version topology because Strapi 5 can serve a
separately hosted Admin against an absolute API URL, the VPS cannot safely
build images or run a second PostgreSQL, and Vercel cannot persist media. Local
persistence survives API container recreation on the same host; it is not
disaster recovery.

Every `main` push deploys both ends. GitHub Environment `production` is the
secret source. Actions publishes `ghcr.io/k4f7/cms:<git-sha>` and an
HMAC-SHA256 timestamped webhook pulls that image without building on the VPS.
A deployment succeeds only after the health response reports the Git SHA and
image digest. Invalid webhook signatures fail closed. This repository does not
host, build, or configure that application, and this decision does not bind the
Archive Read Contract.
