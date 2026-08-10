# Archive QQ read verification

Archive v2 keeps only the public QQ read adapter. Payload Admin is the sole management surface;
QQ does not upload, edit, remove, restore, or retry Archive records.

With a fake or staging Payload boundary configured as `payload.baseUrl` and
`payload.serviceToken`, verify:

1. `/archive.search works [query]` returns matching Work identifiers and metadata.
2. `/archive.works [query]` remains an equivalent Work search shortcut.
3. `/archive.work-query [author] [query]` passes author and text filters to the versioned API.
4. `/archive W<n>` returns the Work header and ordered image/PDF Media in merged-forward messages.
5. A failed individual Media fetch is reported while successful Media remain visible.
6. Missing, malformed, unauthorized, timed-out, or unavailable Payload responses return the stable
   temporary-unavailable message; an unknown valid Work identifier returns `Work 不存在。`.

The deterministic seams are covered by:

```sh
corepack yarn vitest run tests/koishi-smoke.test.ts plugins/memebot-archive/tests/index.test.ts plugins/memebot-archive/tests/payload-read.test.ts
```

The old local PDF/ZIP, Koishi database, R2 backup, manifest, lifecycle, and Console scenarios are
historical and are not current acceptance criteria.
