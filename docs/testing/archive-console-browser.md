# Archive management acceptance

The former Koishi Archive Console browser suite is retired. The `memebot-archive` package no
longer ships a Console entry, management listeners, Vue client, or browser test command.

Archive administration is exercised in the independent Payload application under
`apps/archive-payload/`. Its current acceptance boundary is the unified Work editor creating and
saving a draft, direct-uploading image/PDF Media in selection order, explicitly publishing a
complete aggregate, verifying that drafts remain absent from the Archive Read Contract, editing a
Published Work without changing the current public snapshot, discarding a never-published draft
Media item, withdrawing published Media, and confirming that published physical deletion is
unavailable. A failed publish must leave both the previous publication and the retryable draft
unchanged.

The Koishi package only needs deterministic API/adapter tests and QQ read smoke tests:

```sh
corepack yarn workspace koishi-plugin-memebot-archive test
corepack yarn vitest run tests/koishi-smoke.test.ts plugins/memebot-archive/tests/payload-read.test.ts
```

No local Koishi database, attachment directory, R2 backup fixture, Archive manifest, or
`memebot-access` service is required for the read adapter.
