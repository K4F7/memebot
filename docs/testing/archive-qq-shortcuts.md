# Archive QQ read verification

`memebot-archive` keeps only the public QQ read command surface. Archive
management does not live in this repository. QQ does not upload, edit, remove,
restore, or retry Archive records.

When `origin` or `token` is missing, the plugin stays fail-closed and the four
read commands return `Archive 服务暂时不可用，请稍后重试。`.

When both are configured, Koishi calls only `GET /api/archive/v1/works`,
`GET /api/archive/v1/works/:archiveId`, and `GET /api/archive/v1/media/:mediaId`.

Verify:

1. Unconfigured `/archive.search works [query]`, `/archive.works [query]`,
   `/archive.work-query [author] [query]`, and `/archive W<n>` return the
   temporary-unavailable member message.
2. Search commands pass `query=` (and `author=` for work-query) and show
   archiveId, title, author, and the exact `total`. Empty search is a short
   member message that includes total 0, not `Work 不存在。`.
3. `/archive W<n>` keeps `W<n>` validation and requests that id as `archiveId`.
   Detail shows title, author, and summary; images are sent in list order; PDFs
   are sent as files; captions travel with their media.
4. Contract 404 returns `Work 不存在。`. Unconfigured, network, 401/403, and 5xx
   stay the unavailable message and never reuse the 404 copy.
5. A single media download or send failure does not drop the rest of the Work;
   the failed item gets a clear member-visible hint.

The deterministic seams are covered by Koishi Mock plus a local mock HTTP
contract server:

```sh
corepack yarn vitest run tests/koishi-smoke.test.ts plugins/memebot-archive/tests/index.test.ts
```

Live reads against a production content platform remain a manual check. The old
local PDF/ZIP, Koishi database, R2 backup, manifest, lifecycle, Console, and
Payload adapter scenarios are historical and are not current acceptance
criteria.
