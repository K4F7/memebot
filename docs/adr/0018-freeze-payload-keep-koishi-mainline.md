---
status: accepted
---
# Freeze Payload on an archive branch and keep a Koishi-only mainline

Payload's complete Archive implementation is frozen on the immutable `archive/payload-cms`
branch at `9804752f2d7e6d5957a5ce47c8872750bde988ce`. This repository's `main` branch is a
Koishi plugin repository again. `memebot-archive` remains a publishable QQ read plugin for
Works and Media Items, but it injects no Database, Console, or Access, and it has no content
backend until a later Strapi adapter is bound. Until then, the registered QQ read commands
fail closed with the temporary-unavailable member message.

This decision supersedes ADR 0011, ADR 0013, ADR 0014, ADR 0016, and ADR 0017. Those files
remain in the tree as historical records and are not rewritten. ADR 0012 and ADR 0015 remain
accepted domain decisions for Work, Media Item, and WorkMedia Relationship; their Payload or
R2 sentences are historical. The Archive Read Contract is now the unbound machine-facing read
boundary, not a Payload API. Archive Administrator is a content-platform identity, not a QQ
identity and not PayloadCMS, and it does not grant memebot-access authorization.
