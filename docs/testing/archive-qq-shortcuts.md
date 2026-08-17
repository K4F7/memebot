# Archive QQ read verification

Archive remains a public QQ read plugin. Management does not live in this repository.
The content backend is unbound, so the registered read commands fail closed.

Verify:

1. `/archive.search works [query]` remains registered and returns the temporary-unavailable member message.
2. `/archive.works [query]` remains an equivalent Work search shortcut and returns the same unavailable result.
3. `/archive.work-query [author] [query]` remains registered and returns the same unavailable result.
4. `/archive W<n>` remains registered and returns the same unavailable result, not `Work 不存在。`.
5. Image and PDF delivery remains the documented future read result once a later adapter binds the Archive Read Contract.
6. A missing backend is distinct from an unknown Work; `Work 不存在。` is reserved for a later bound backend.

The deterministic seams are covered by:

```sh
corepack yarn vitest run tests/koishi-smoke.test.ts plugins/memebot-archive/tests/index.test.ts
```

The old local PDF/ZIP, Koishi database, R2 backup, manifest, lifecycle, Console, and Payload
adapter scenarios are historical and are not current acceptance criteria.
