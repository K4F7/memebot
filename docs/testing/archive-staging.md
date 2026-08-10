# Archive staging acceptance (retired VPS runbook)

This file is retained as a historical record for issue #52. The VPS, SSH, GHCR, and staging
workflows it described have been removed and must not be recreated for production.

The current production boundary is Vercel Git Integration + Neon PostgreSQL + private Cloudflare
R2. Use [`archive-vercel.md`](archive-vercel.md) for the deployment and acceptance path. The
deterministic repository checks remain:

```sh
corepack yarn typecheck
corepack yarn test
corepack yarn build
```

The old Docker/Compose files under `apps/archive-payload/deploy/` are retained only for local or
manual compatibility and are not a staging deployment mechanism.
