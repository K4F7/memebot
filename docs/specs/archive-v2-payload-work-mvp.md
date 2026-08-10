# Archive v2: Payload Work media MVP and Koishi read adapter

## Problem Statement

Archive administration is currently coupled to Koishi's database, local attachment directory, Console WebUI, and QQ management flows. The current Work model assumes one ZIP Work Package, which does not fit the desired workflow of managing individual images and PDFs in a PayloadCMS administration surface.

The team has no production Archive data to migrate. We can therefore introduce a clean Archive v2 boundary in which PayloadCMS is the content authority, while Koishi remains the QQ-facing read and delivery adapter.

## Solution

Deploy an independent PayloadCMS application as a Node.js/Next.js project on Vercel, using Neon PostgreSQL for Archive metadata and a private Cloudflare R2 bucket for Media Items through its S3-compatible API. The public service name is `meme.sein.moe` (or the configured Vercel custom domain). Vercel Git Integration automatically builds and deploys the connected production branch; GitHub Actions is limited to repository typecheck, test, and build checks. Payload's authenticated Admin UI is the only Archive management surface in the MVP.

Expose a stable `/api/archive/v1` read contract from Payload. The Koishi `memebot-archive` plugin authenticates as a machine client, searches Works through that contract, and retrieves short-lived protected media access for QQ delivery. A Work is readable only after an explicit publish operation atomically promotes a complete versioned aggregate; drafts and unpublished edits remain private.

The first vertical slice covers Works and ordered image/PDF Media Items. Paper/Newspaper Issue, Publication Appearance, lifecycle retention, backup, restore, and derived previews remain later work.

## User Stories

1. As an Archive Administrator, I want to sign in to PayloadCMS, so that Archive management is separated from QQ conversation flow.
2. As an Archive Administrator, I want all authorized Payload users to reach the Archive collections, so that the MVP does not require a premature role system.
3. As an Archive Administrator, I want to create a Work with a title, author, and optional description, so that the work has searchable context before media is attached.
4. As an Archive Administrator, I want each Work to receive a stable `W<n>` Archive Identifier, so that QQ references remain short, readable, and unique.
5. As an Archive Administrator, I want every Media Item to be assigned to a Work at upload time, so that ownership is explicit even before presentation order is configured.
6. As an Archive Administrator, I want a Work to require an explicitly published version containing at least one valid WorkMedia relationship before it is readable, so that QQ never exposes an empty, partial, or unassociated Work.
7. As an Archive Administrator, I want to upload image Media Items, so that common visual works can be archived directly.
8. As an Archive Administrator, I want to upload PDF Media Items, so that document-based works can be archived without packaging them.
9. As an Archive Administrator, I want unsupported media classes to be rejected by the collection configuration, so that the MVP does not silently accept audio, video, or arbitrary files.
10. As an Archive Administrator, I want each Media Item to belong to exactly one Work and remain bound to that Work, while appearing in at most one WorkMedia relationship, so that ownership and presentation stay unambiguous.
11. As an Archive Administrator, I want different Media Items to be allowed to share a display filename, so that filenames do not become accidental global identifiers.
12. As an Archive Administrator, I want each Work's Media Items to have a unique non-negative display order normalized from zero without gaps during writes, so that QQ delivery follows a deterministic presentation order.
13. As an Archive Administrator, I want an optional caption on each WorkMedia relationship, so that a delivered item can carry minimal context without duplicating Work metadata.
14. As an Archive Administrator, I want R2 objects to remain private, so that an unguessable object URL is not treated as authorization.
15. As an Archive Administrator, I want to publish a complete Work draft explicitly, so that metadata and ordered media become readable together without exposing intermediate edits.
16. As an Archive Administrator, I want incomplete or unassociated uploads excluded from the Archive read contract, so that a partial form submission is not presented as a Work; a missing R2 object is reported only when that media is requested.
17. As an Archive Administrator, I want any Archive Administrator to withdraw an erroneous Media Item by setting `withdrawnAt` without physically deleting its metadata or private object, so that the record can be audited while no longer being delivered.
18. As an Archive Administrator, I want Payload to persist metadata in PostgreSQL, so that the CMS database is the single Archive content authority.
19. As an Archive Administrator, I want Payload to persist media bytes in R2, so that large files are not stored in PostgreSQL.
20. As an Archive Administrator, I want uploads to avoid base64 conversion and unnecessary application buffering, so that larger media can pass through the R2 S3 storage path safely.
21. As a QQ member, I want to search Works by the supported metadata and receive an exact match count, so that I can find an archived Work without entering the Payload admin site.
22. As a QQ member, I want to request a Work by its `W<n>` identifier, so that I can retrieve a known Work directly.
23. As a QQ member, I want the Work details and its Media Items delivered in their configured order, so that the QQ presentation matches the administrator's intent.
24. As a QQ member, I want multiple media to arrive as one or more QQ merged-forward messages, so that a multi-item Work remains readable without being repackaged into a ZIP.
25. As a QQ member, I want a failed individual media delivery to be reported without hiding successful items, so that one bad object does not make the whole Work request opaque.
26. As a QQ member, I want searches and retrieval to continue using the existing Archive command vocabulary where it remains applicable, so that the backend migration does not require relearning public commands.
27. As a Koishi operator, I want the plugin to call the canonical versioned `/api/archive/v1/works` and `/api/archive/v1/media` contract, so that Payload collection changes do not silently break QQ behavior.
28. As a Koishi operator, I want machine authentication to use a dedicated service credential, so that the plugin does not impersonate a human Payload administrator.
29. As a Koishi operator, I want short-lived protected media access from Payload, so that the plugin can fetch media without making the R2 bucket public.
30. As a Koishi operator, I want the adapter to fail with a clear temporary-unavailable result when Payload cannot be reached, so that the user receives an honest response instead of stale or invented data.
31. As an Archive maintainer, I want the Payload application and Koishi plugin to be independently deployable, so that either side can evolve without sharing a package-level runtime dependency.
32. As an Archive maintainer, I want the old Koishi Archive WebUI and QQ administrative upload/edit flows removed from the v2 boundary, so that there is one authoritative management surface.
33. As an Archive maintainer, I want the Archive plugin to have no `memebot-access` dependency when it exposes only public reads, so that QQ administrator state is not duplicated in Payload.
34. As an Archive maintainer, I want the MVP to make no production-data migration assumptions, so that the clean v2 model can be implemented without compatibility code for existing records.
35. As an Archive maintainer, I want Paper/Newspaper Issue to remain a later independent PDF model, so that the Work media redesign does not erase the newspaper domain.
36. As an Archive maintainer, I want Publication Appearance to remain a later explicit relationship, so that a future Paper/Work connection does not get hidden in copied text fields.
37. As an Archive maintainer, I want backup manifests, automated restore, lifecycle retention, and derived previews explicitly deferred, so that Payload defaults are not mistaken for disaster-recovery guarantees.

## Implementation Decisions

- The highest seam is the Payload `/api/archive/v1` boundary. Payload owns content writes and protected media access; Koishi owns only QQ search, retrieval, and delivery behavior. Tests should cross this seam rather than couple directly to Payload collection internals.
- The Payload application is an independent deployable project rooted at `apps/archive-payload`. It targets Vercel's Node.js/Next.js runtime with Neon PostgreSQL and a private R2 bucket accessed through the S3 API. The application uses Payload's authenticated Admin UI, Users collection, and default collection administration behavior. Vercel Git Integration owns production deployment; GitHub Actions does not deploy the app.
- PostgreSQL is the source of truth for Work metadata and WorkMedia relationships. R2 is the source of truth for Media Item bytes. The Koishi plugin does not maintain a second Archive write model, local attachment copy, or Console management surface.
- A Work has title, author, optional description, a stable `W<n>` Archive Identifier, and at least one WorkMedia relationship. Paper/Newspaper Issue keeps its separate `P<n>`/PDF model for the later Paper slice.
- A Media Item is a Payload-managed file initially restricted to image and PDF media types. Audio, video, HTML/SVG, arbitrary files, derived previews, and ZIP packaging are outside this MVP.
- WorkMedia is a lightweight presentation relationship record containing the Work reference, Media reference, a unique non-negative display order normalized from zero without gaps in the write transaction, and an optional caption. `Media.work` is the immutable ownership fact; a WorkMedia record must agree with it, and a Media Item is not reused across Works. Payload-managed file metadata remains the source for filename, MIME type, and size. Media must have an owning Work at upload time, while the presentation relationship may be added afterward.
- Media filenames are display metadata and may repeat. Each Media Item persists an independently generated internal R2 object key; reads, deletes, and future lifecycle operations use that key rather than reconstructing storage identity from filename.
- Work and its ordered media manifest become visible to the read API only after an explicit publish operation promotes a complete versioned aggregate containing at least one non-withdrawn Media Item. Drafts, unpublished edits, and unfinished uploads must not appear as a Work in the read API. The read API does not require an R2 probe while listing a Work; a missing object returns not-found when its signed media URL is served.
- Published Media physical deletion is not an MVP operation. Delete access is disabled for Work, Media, and WorkMedia collection writes; the Work Authoring API may discard a never-published draft Media Item after recording a retryable cleanup intent. Any authenticated Archive Administrator may withdraw an erroneous published Media Item with `withdrawnAt` while retaining its metadata, WorkMedia relationship, and private R2 object; the read API excludes withdrawn items. A Work with no remaining readable Media Items is hidden, while its stable Work identifier remains reserved.
- R2 objects remain private. The read API returns short-lived protected access for the Koishi machine client; the Koishi plugin never exposes long-lived storage credentials to QQ users.
- The external API is a stable custom `/api/archive/v1` adapter layer. Its canonical paths are `GET /works?query=&author=`, `GET /works/:archiveId`, and signed `GET /media/:mediaId?expires=&signature=` below that prefix. Payload's generated collection endpoints and Local API may implement it internally, but collection field names and automatic REST paths are not cross-repository contracts.
- The canonical search response is `{ data, total }`, where `total` is exact and `data` is capped at 1000 items in the MVP; the canonical Work detail response is `{ data }`, and search/detail require the dedicated machine credential. Compatibility aliases remain for one Koishi release cycle after client migration, then are removed.
- The Koishi public surface keeps read-only search and retrieval. Multi-item Work delivery sends the details plus ordered media as one or more QQ merged-forward messages, reporting per-item failures. QQ-side publishing, editing, removal, restore, backup retry, and other administrative writes are not part of this boundary.
- The existing Archive-specific `memebot-access` runtime dependency is removed because this slice has no protected QQ writes. The global Access architecture remains applicable to any future plugin operation that becomes protected.
- The old local-first attachment model, Koishi metadata tables, Console WebUI, ZIP Work Package, Archive manifest, automated backup queue, restore queue, 30-day lifecycle, and ZIP-derived preview are not reimplemented in this MVP. The accepted v2 ADRs record these as superseded or explicitly deferred.
- No production data migration is planned. The implementation may choose clean Payload IDs and fresh R2 object keys for media while preserving only the new public `W<n>` business identifier contract; the empty database still receives the initial Payload schema migration during deployment.
- The empty production database still needs the checked-in Payload schema migration. An operator runs it manually with a direct/unpooled Neon `DATABASE_MIGRATION_URL`; that URL is never a Vercel Runtime Environment variable, and Vercel request-serving instances never apply migrations. No legacy data migration or compatibility layer is required, and a deployment rollback never downgrades the database schema.

## Testing Decisions

- Tests assert externally observable behavior at the Payload API/Koishi adapter seam. They should not assert Payload hook ordering, database adapter internals, generated REST implementation details, or R2 key randomness.
- Payload integration tests cover Admin authentication, Work creation, stable `W<n>` assignment, image/PDF Media upload restrictions, complete manifest saves, stale revision conflicts, draft isolation, explicit publication, rollback continuity, one-Work ownership, and published-only read visibility.
- API contract tests cover machine authentication, canonical search and detail response shapes, exact totals with the 1000-item cap, unique contiguous media order, duplicate display filenames, private-media access behavior, withdrawn media exclusion, hidden all-withdrawn Works, missing R2 objects, expired/invalid credentials, and clear unavailable responses.
- Koishi adapter tests use the existing Koishi test harness style with a fake HTTP Payload boundary. They cover search, direct Work lookup, ordered merged-forward delivery, PDF/image handling, per-item fetch failure, and API-unavailable messaging.
- Browser acceptance tests cover the unified Work editor for creating a Work draft, direct-uploading and ordering Media, saving without public visibility, explicitly publishing, editing a Published Work without changing the current read result, withdrawing an erroneous Media Item, and confirming that physical deletion is unavailable. They should verify user-visible behavior rather than Payload component structure.
- A manually run Vercel Production smoke test may exercise Neon PostgreSQL, R2 S3 access, direct client upload, duplicate display filenames, and signed media access without placing credentials in the repository or normal test logs. Preview is build-only until an isolated Neon/R2 environment exists. It is supplemental to deterministic tests and is not required for default local runs.
- Repository verification should retain the existing typecheck/build/test conventions for the Koishi packages, plus the Payload project's own typecheck/build and API integration checks.

## Out of Scope

- Paper/Newspaper Issue administration and PDF publication flow in the first slice.
- Publication Appearance creation, ordering, and bidirectional Paper/Work navigation.
- Audio, video, HTML/SVG, arbitrary file types, ZIP Work Packages, and derived Work previews.
- Review/published moderation workflows, roles beyond a single authenticated Archive Administrator class, and external SSO. Draft-backed Work authoring and explicit publication are in scope under ADR 0017.
- Archive manifests, R2 backup copies, backup retries, restore previews, restore history, cleanup queues, 30-day retention, anonymization, and lifecycle audit.
- Koishi database metadata, local attachment storage, long-lived read caches, or a second source of truth.
- Public R2 objects, anonymous Payload management, human-admin credentials used by Koishi, or direct public Payload API access for QQ members.
- QQ-side administrative upload, edit, remove, restore, or operational commands.
- Migration of production records or compatibility with the superseded ZIP/local-first implementation.
- Changes to unrelated memebot plugins; this work is intentionally focused on `memebot-archive` and its independent Payload application.

## Further Notes

- The shared glossary now defines Work, Media Item, WorkMedia Relationship, Archive Identifier, and Archive Read Contract. Archive v2 decisions are recorded in ADR 0011 through ADR 0016; ADR 0001, ADR 0005, ADR 0007, and ADR 0008 are marked superseded.
- Before implementing the full Archive surface, the Work vertical slice should prove the Vercel + Neon PostgreSQL + R2 S3 deployment path, the machine-authenticated API seam, and QQ merged-forward delivery.
- The absence of production data is a deliberate part of this decision. If production data appears before implementation is complete, stop and add a migration/compatibility decision before changing the model.
