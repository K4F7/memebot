# Archive QQ read verification

`memebot-archive` keeps only the public QQ read command surface. No content
backend is configured on the Koishi mainline; Archive management does not live
in this repository. QQ does not upload, edit, remove, restore, or retry Archive
records.

Verify the fail-closed surface:

1. `/archive.search works [query]` remains registered and returns the temporary-unavailable member message.
2. `/archive.works [query]` remains an equivalent Work search shortcut with the same unavailable result.
3. `/archive.work-query [author] [query]` remains registered with the same unavailable result.
4. `/archive W<n>` remains registered with the same unavailable result.
5. Image and PDF delivery remains the documented future read result once a later adapter binds the Archive Read Contract.
6. An unknown or unreadable Work must stay distinct from a missing backend once a backend exists later; do not reuse `Work 不存在。` for configuration failure.

The deterministic seams are covered by:

```sh
corepack yarn vitest run tests/koishi-smoke.test.ts plugins/memebot-archive/tests/index.test.ts
```

The old local PDF/ZIP, Koishi database, R2 backup, manifest, lifecycle, Console,
and Payload adapter scenarios are historical and are not current acceptance
criteria.
