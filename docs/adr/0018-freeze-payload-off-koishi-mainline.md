---
status: accepted
---
# Freeze Payload off the Koishi mainline

The Payload Archive implementation is frozen on the immutable remote branch
`archive/payload-cms` at commit `9804752f2d7e6d5957a5ce47c8872750bde988ce`. That
branch remains the retrievable Payload tree; this repository's `main` line is a
Koishi plugin monorepo again and does not build, test, deploy, or configure
Payload.

On `main`, `memebot-archive` stays an installable QQ read plugin. It injects no
Database, Console, or Access, registers the public Work and Media Item read
commands, and fail-closes with the temporary-unavailable member message until a
later content-platform adapter binds the Archive Read Contract. Archive
management does not live in this repository. No Strapi client is introduced by
this decision.

This decision supersedes ADR 0011, ADR 0013, ADR 0014, ADR 0016, and ADR 0017.
ADR 0012 and ADR 0015 remain accepted domain decisions for Work, Media Item,
WorkMedia Relationship, and the unbound Archive Read Contract vocabulary; their
Payload and R2 operating sentences are historical. Existing ADR files are kept
rather than deleted or rewritten.
