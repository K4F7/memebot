---
status: superseded by ADR-0011
---
# Keep archive storage local-first

Archived attachments are committed to local storage first, while Cloudflare R2 holds a secondary recovery copy. An archive operation succeeds once the local copy is durable; an R2 failure is recorded for retry rather than failing the user operation, and reads use the local copy before attempting recovery from R2. A failed local-storage preflight disables attachment writes, while a failed R2 preflight leaves the plugin available in a degraded local-only mode.
