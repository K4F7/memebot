---
status: accepted
---
# Make Payload the Archive content authority

Archive v2 stores Paper and Work metadata, relationships, and public content state in Payload backed by PostgreSQL; Payload's private Cloudflare R2 media objects are the authoritative attachment bytes. The Payload application is self-hosted on the VPS and deployed by GitHub Actions, while the independently deployed Koishi plugin remains a read-only QQ adapter that calls the versioned `/api/archive/v1` service with a machine credential and receives short-lived protected media access. The old Koishi database, local attachment store, Console WebUI, and Archive-specific Access dependency are removed from this boundary. This decision supersedes ADR 0001, ADR 0005, and ADR 0007; no production data migration is required for the initial rollout.
