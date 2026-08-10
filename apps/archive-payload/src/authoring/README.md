# Work Authoring API (shared contract)

Shared request/response/error fixtures for:

- Backend Issue #59 — authenticated Work Authoring API implementation
- Frontend Issue #60 — unified Payload Work media editor

## Surface

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/work-authoring/v1/works` | Create Draft Work |
| `GET` | `/api/work-authoring/v1/works/:workId` | Load draft + published summary |
| `PUT` | `/api/work-authoring/v1/works/:workId/draft` | Save complete draft manifest |
| `POST` | `/api/work-authoring/v1/works/:workId/publish` | Publish current draft |
| `POST` | `/api/work-authoring/v1/works/:workId/uploads/authorize` | Direct R2 upload authorization |
| `POST` | `/api/work-authoring/v1/works/:workId/uploads/finalize` | Finalize upload (idempotent) |
| `DELETE` | `/api/work-authoring/v1/works/:workId/media/:mediaId` | Discard never-published draft media |

Authentication: Payload Admin session (`credentials: 'include'`).

Every aggregate mutation supplies the last observed opaque `revision` token. A mismatch returns `stale_revision` with `currentRevision` and optional `aggregate`.

Types: `contract.ts`. Deterministic fixtures: `fixtures.ts`. Browser client: `client.ts`.
