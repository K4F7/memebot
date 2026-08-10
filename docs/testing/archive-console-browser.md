# Archive management acceptance

The former Koishi Archive Console browser suite is retired. The `memebot-archive` package no
longer ships a Console entry, management listeners, Vue client, or browser test command.

Archive administration is exercised in the independent Payload application under
`apps/archive-payload/`. Its current acceptance boundary is Payload Admin creating a Work,
assigning image/PDF Media, creating ordered WorkMedia relationships, withdrawing Media, and
confirming that physical deletion is unavailable.

The Koishi package only needs deterministic API/adapter tests and QQ read smoke tests:

```sh
corepack yarn workspace koishi-plugin-memebot-archive test
corepack yarn vitest run tests/koishi-smoke.test.ts plugins/memebot-archive/tests/payload-read.test.ts
```

No local Koishi database, attachment directory, R2 backup fixture, Archive manifest, or
`memebot-access` service is required for the read adapter.
