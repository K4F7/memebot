# Archive management acceptance

Archive management no longer lives in this repository. The `memebot-archive` package does
not ship a Console entry, management listeners, Vue client, browser test command, Payload
Admin surface, or local Archive tables.

The Koishi package only needs deterministic QQ read smoke tests for the fail-closed command
surface:

```sh
corepack yarn workspace koishi-plugin-memebot-archive test
corepack yarn vitest run tests/koishi-smoke.test.ts
```

No local Koishi database, attachment directory, R2 backup fixture, Archive manifest,
`memebot-access` service, or Payload configuration is required.
