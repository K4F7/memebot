# Archive management acceptance

The former Koishi Archive Console browser suite is retired. The `memebot-archive`
package no longer ships a Console entry, management listeners, Vue client, or
browser test command.

Archive management does not live in this repository. The frozen Payload tree
remains on `archive/payload-cms` and is not built, tested, or deployed from
`main`. The first-version content platform lives in independent `K4F7/cms`;
Vercel Admin deployment is owned by that repository, not this plugin monorepo.

The Koishi package only needs fail-closed QQ read coverage:

```sh
corepack yarn workspace koishi-plugin-memebot-archive test
corepack yarn vitest run tests/koishi-smoke.test.ts
```

No local Koishi database, attachment directory, R2 backup fixture, Archive
manifest, Payload configuration, or `memebot-access` service is required for the
current read surface.
