# Strapi first-version content platform

## Problem Statement

Archive Administrator needs a content platform independent of the Koishi
mainline so that Works can be created, edited, and published, and Media Items
can be uploaded and previewed. The Koishi mainline has already frozen Payload.
The target VPS has a documented resource and operating boundary. What is still
missing is a verified, deployable Strapi Admin, API, PostgreSQL, local media,
and release path.

The first version must work without a second PostgreSQL service, without
building images on the VPS, and without storing media only in a container
writable layer. This slice does not build backups or disaster recovery. It can
promise recreation of the API container on the same VPS. It cannot promise
recovery after host or disk loss.

## Solution

Create an independent `K4F7/cms` Strapi 5 application. Vercel hosts the
prebuilt Admin. The Strapi API, authentication, and local upload provider run
on VPS `louis`, with OpenResty as the stable HTTPS ingress. The API uses a
dedicated database and user on the existing 1Panel PostgreSQL instance. Media
is written to an explicit host bind mount.

Every push to `main` produces both a Vercel Admin deployment and a GHCR API
image tagged with the Git SHA. GitHub Actions triggers the VPS through an
HMAC-authenticated, timestamped webhook. The VPS pulls the requested image,
recreates the Strapi container, and reports success only after a health check
passes. The product file-size limit is 50 MiB. The reverse-proxy request-body
limit leaves extra room for multipart overhead.

This specification is recorded in the Koishi plugin repository so the operating
contract is reviewable next to the accepted domain vocabulary. Production
implementation happens in `K4F7/cms` through the child tickets. This repository
must not grow a Strapi application, Admin frontend, or Strapi client.

## User Stories

1. As an Archive Administrator, I want to open the Strapi Admin from a stable HTTPS origin, so that I can manage Archive content without accessing the VPS directly.
2. As an Archive Administrator, I want to log in through the separated Admin and API deployment, so that authentication works despite the two different origins.
3. As an Archive Administrator, I want my authenticated session to refresh correctly, so that ordinary editing sessions do not fail unexpectedly.
4. As an Archive Administrator, I want failed or expired authentication to produce a clear response, so that I know when to sign in again.
5. As an Archive Administrator, I want to create a Work, so that new Archive content can be recorded.
6. As an Archive Administrator, I want to edit an existing Work, so that its metadata and content can be corrected.
7. As an Archive Administrator, I want to publish a Work, so that its published state is explicit and available to later read integrations.
8. As an Archive Administrator, I want to keep draft changes separate from published content where Strapi supports that workflow, so that incomplete edits are not exposed as published records.
9. As an Archive Administrator, I want to upload a Media Item from the Admin, so that images and PDFs can be attached to Archive content.
10. As an Archive Administrator, I want uploaded media to be previewable from the Admin, so that I can verify the correct file was stored.
11. As an Archive Administrator, I want media references to remain valid after the API container is recreated, so that deployments do not destroy uploads.
12. As an Archive Administrator, I want files within the 50 MiB product limit to upload successfully, so that supported media sizes behave reliably.
13. As an Archive Administrator, I want oversized files to fail with understandable feedback, so that I can correct the upload without guessing.
14. As an Archive Administrator, I want interrupted or failed uploads not to create misleading successful records, so that the Media Library remains trustworthy.
15. As an Archive Administrator, I want CORS and cookie behavior to work in supported browsers, so that the Vercel/VPS split does not degrade authoring.
16. As an operator, I want PostgreSQL to remain private and reused through a dedicated database and user, so that Strapi does not add an unnecessary database service or public port.
17. As an operator, I want media stored in an explicit host bind mount, so that container replacement leaves uploaded files intact.
18. As an operator, I want TLS termination and request-size policy enforced by OpenResty, so that the public API has one controlled ingress boundary.
19. As an operator, I want a deployment webhook authenticated with HMAC and a timestamp, so that untrusted callers cannot activate a deployment.
20. As an operator, I want webhook requests with invalid signatures to fail closed, so that failed authentication cannot reach the deployment process.
21. As an operator, I want each API image identified by its Git SHA and digest, so that the deployed code can be traced to a source revision.
22. As an operator, I want deployments to pull prebuilt images rather than build on the VPS, so that CMS releases do not exhaust the shared host.
23. As an operator, I want a deployment to succeed only after the API health check passes, so that CI does not report an unusable release as healthy.
24. As an operator, I want to redeploy the previous successful API image and select a previous Vercel deployment, so that a compatible release can be restored without SSH being the normal deployment path.
25. As an operator, I want failed releases to preserve their diagnostic image and logs, so that failure analysis remains possible.
26. As a developer, I want Admin and API builds to derive from the same source revision, so that configuration and Strapi version changes remain coordinated.
27. As a developer, I want production secrets managed through the GitHub production Environment and materialized only at deployment time, so that secrets are not committed to the CMS repository.
28. As a developer, I want browser-level evidence for login, session refresh, upload, preview, edit, and publish, so that the split topology is validated through externally observable behavior.
29. As a developer, I want deployment-level evidence from webhook invocation through health response, so that release behavior is validated without coupling tests to shell implementation details.
30. As a maintainer, I want Payload-specific runtime assumptions excluded from the new platform, so that the archived implementation does not leak back into the Koishi mainline or Strapi design.

## Implementation Decisions

- Use one standard Strapi 5 application in the independent `K4F7/cms`
  repository. Do not split Admin and API into separate application trees. The
  repository root is the Strapi app (`config/`, `src/`) plus
  `deploy/compose.yml`.
- Record this specification here; implement the production platform only
  through the child tickets. Do not add Strapi, a custom Admin, or a Strapi
  HTTP client to this Koishi plugin monorepo.
- Vercel hosts only the prebuilt Admin assets. It is not a database, API
  runtime, or persistent media store.
- The VPS `louis` hosts Strapi API, authentication, the local upload provider,
  and an explicit persistent media bind mount. Place the Compose stack under
  the existing 1Panel compose layout. Watchtower must not track the Strapi
  container.
- Use stable HTTPS origins for Admin and API. CORS must allow only the
  configured Admin origin with credentials. Production must not use a wildcard
  origin. `meme.sein.moe` is already occupied and is not assumed to be the
  Strapi API hostname.
- Cookie settings must be compatible with the selected HTTPS origins and
  verified in the deployment prototype. Authentication behavior is not
  considered complete from configuration review alone.
- Reuse the existing 1Panel PostgreSQL 18 instance with a dedicated Strapi
  database and user. Keep database connectivity on loopback. Do not add a
  second PostgreSQL service and do not expose the database port.
- Media must survive API container recreation and must not be stored only in
  the image or container writable layer. Local persistence protects against
  container replacement on the same root filesystem. It is not disaster
  recovery.
- The product file-size limit is 50 MiB. Strapi upload middleware and provider
  limits enforce that product limit. The OpenResty request-body limit must be
  larger than 50 MiB so multipart overhead does not reject a valid product
  upload. The current global OpenResty cap of 50m is not sufficient for that
  site.
- Every `main` push deploys Admin through Vercel Git Integration and builds
  `ghcr.io/k4f7/cms:<git-sha>` through GitHub Actions. Do not path-filter the
  API away from Admin-only commits. Tags may name paired rollback snapshots;
  they are not the daily deploy switch.
- GitHub Environment `production` is the authoritative secret source, including
  the database password. Runtime secrets are injected into VPS `deploy/.env` at
  deploy time and are not committed. Vercel stores only the public build
  configuration required by Admin, such as the public API URL. Actions runners
  do not connect to loopback PostgreSQL.
- GitHub Actions sends an HTTPS deployment request authenticated with
  HMAC-SHA256 over the raw body and timestamp. Invalid, stale, or replayed
  requests fail closed and must not pull, recreate, or otherwise activate a
  deployment. Request bodies are not written to access logs.
- The VPS pulls the requested image and recreates the API without building
  locally and without a self-hosted runner. SSH and Watchtower are not normal
  Strapi deployment triggers.
- Deployment success requires a timely health response containing the deployed
  Git SHA and image digest. A failed health check fails the workflow, does not
  auto-rollback, and does not prune diagnostic images.
- After a successful health check, the VPS keeps only the running
  `ghcr.io/k4f7/cms` image and the previous successful image, plus dangling
  layer cleanup. GHCR history is not deleted.
- API rollback reuses a previous successful image through the same webhook.
  Admin rollback selects a previous Vercel deployment. Automatic database or
  data rollback is not promised.
- Avoid destructive or irreversible database migrations while backup and
  recovery remain out of scope.
- Preserve the accepted domain vocabulary of Work, Media Item, WorkMedia
  Relationship, Archive Administrator, and the unbound Archive Read Contract.
  This spec does not bind the Koishi read adapter.

## Testing Decisions

- The primary authoring seam is a real-browser flow from the deployed Admin
  origin through the public API origin. Tests assert visible login, session
  refresh, Work authoring, publishing, upload, preview, and error behavior
  rather than internal React or Strapi implementation details.
- The primary deployment seam starts with an authenticated webhook request and
  ends with the externally observable health response and deployed revision.
  Tests do not assert private shell function structure.
- [#69](https://github.com/K4F7/memebot/issues/69) is the required deployment
  prototype. It must capture reproducible configuration, browser network
  evidence, verification steps, and known limitations before production
  implementation tickets begin.
- Verify an upload below the product limit succeeds and remains previewable
  after API container recreation.
- Verify an upload above the product limit fails predictably and does not
  appear as a successful Media Item.
- Verify CORS rejects an unapproved origin and accepts the configured Admin
  origin with credentials.
- Verify invalid, stale, and replayed webhook signatures fail closed without
  activating a deployment.
- Verify a successful deployment reports the requested Git SHA and image digest
  only after health checks pass.
- Verify a failed health check fails CI and does not prune diagnostic images.
- Prefer a small number of high-level contract and deployment tests over
  duplicated low-level implementation tests.
- Production acceptance requires the same browser and deployment checks against
  a production-shaped environment, not only local development.

## Out of Scope

- Backups, off-box storage, disaster recovery, restore drills, RPO, and RTO.
- Recovery from VPS loss, disk failure, database deletion, or media deletion.
- Cloudflare R2 or another object store as the serving path for Media Items.
- Payload data migration or reactivation of the archived Payload runtime.
- Koishi-to-Strapi read integration and binding the Archive Read Contract.
- A custom public content website or custom authoring frontend.
- A second PostgreSQL instance, a self-hosted GitHub Actions runner, or image
  builds on the VPS.
- SSH-initiated routine deployment and Watchtower-managed Strapi updates.
- Automatic database or schema rollback after a failed release.
- Adding Strapi, Admin assets, or a content-platform client to this repository.

## Further Notes

- This specification records the decision from
  [#64](https://github.com/K4F7/memebot/issues/64) and consumes the research
  and contracts established by
  [#62](https://github.com/K4F7/memebot/issues/62),
  [#63](https://github.com/K4F7/memebot/issues/63), and
  [#65](https://github.com/K4F7/memebot/issues/65).
- Research evidence remains on the recorded branches:
  `docs/research/strapi-admin-vps-split.md` at `508faca0f51d5e72363b7ed0c949c3713d0a33f0`,
  `docs/research/vps-runtime-constraints.md` at `fc24c5a68eb5d4d97704360166ff4826054bf4e3`,
  and `docs/research/cms-cicd-contract.md` at `b3d344ec67bc0c02e5dfe6d574ba21d2aa78b3e4`.
- [#69](https://github.com/K4F7/memebot/issues/69) must complete before the
  production implementation tickets begin.
- Production implementation sequence:
  [#79](https://github.com/K4F7/memebot/issues/79) login baseline,
  [#81](https://github.com/K4F7/memebot/issues/81) Work authoring,
  [#82](https://github.com/K4F7/memebot/issues/82) Media Item upload,
  [#83](https://github.com/K4F7/memebot/issues/83) GHCR webhook release,
  and [#84](https://github.com/K4F7/memebot/issues/84) production-shaped
  acceptance. Koishi read binding remains
  [#70](https://github.com/K4F7/memebot/issues/70).
- The current VPS has one root filesystem. Local persistence protects against
  container replacement only and must not be described as disaster recovery.
- The historical Payload/Vercel/Neon/R2 ADRs remain superseded as runtime
  decisions. ADR 0018 remains the Koishi-mainline freeze. ADR 0019 records the
  Strapi operating boundary. ADR 0012 and ADR 0015 remain accepted domain
  decisions. Only the accepted Work, Media Item, WorkMedia Relationship,
  Archive Administrator, and Archive Read Contract vocabulary carries forward.
