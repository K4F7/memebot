---
status: accepted
---
# Serve the Archive Read Contract from the Strapi content platform

The canonical machine read boundary for Archive remains the versioned
`/api/archive/v1` contract from ADR 0015. It is served by the Strapi content
platform in `K4F7/cms` as dedicated content-api routes; no new Strapi-facing
adapter contract is introduced. Koishi's `memebot-archive` binds this contract
through configuration (contract origin plus machine credential) and never
calls Strapi's native collection REST (`/api/works`), Content Manager, Admin
API, or Media Library surfaces directly, so Strapi upgrades and content-model
changes stay behind the frozen seam.

Every contract endpoint requires the dedicated static machine credential as an
HTTP bearer token. The first Strapi version stores media on the VPS local
filesystem without R2, so protected media are served through the authenticated
contract endpoint `GET /api/archive/v1/media/:mediaId`, which returns bytes
only for a Media Item presented in a readable published Work. This supersedes
ADR 0015's signed `expires=&signature=` media URL sentence, which was an
R2-era operating detail. The rest of ADR 0015 remains accepted: the published
readability rule, the `{ data, total }` search shape with an exact `total`,
the `{ data }` detail shape, and stable Archive Identifiers.

Direct Strapi upload paths (`/uploads/...`) are not part of the contract and
carry no compatibility promise toward Koishi. Extending the contract
representation (Work search, the ordered media manifest, and media download)
is content-platform work in `K4F7/cms`; binding the Koishi read adapter is
tracked by K4F7/memebot#70 and does not change `memebot-access`
authorization: Archive reads stay public QQ commands.
