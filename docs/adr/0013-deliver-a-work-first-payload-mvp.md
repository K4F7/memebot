---
status: accepted
---
# Deliver a Work-first Payload MVP

The first Archive v2 slice delivered Payload's default authenticated administration for Work and Media
records, where a completed relationship made the Work immediately readable through
`/api/archive/v1`. That immediate-read rule is superseded by ADR 0017: the current implementation
uses a unified draft-backed Work authoring API and explicit publication. Koishi still sends ordered
published media as one or more QQ merged-forward messages. Paper and Publication Appearance
integration, Archive manifests, backup and restore queues, local Koishi copies, 30-day lifecycle
retention, and derived Work previews remain explicit later work rather than implied guarantees of
Payload's defaults.
