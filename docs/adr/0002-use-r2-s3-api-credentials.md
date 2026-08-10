---
status: superseded by ADR-0011
---
# Access R2 through its S3-compatible API

The archive plugin connects to Cloudflare R2 with an account ID, bucket name, access key ID, and secret access key instead of a Workers binding. This keeps the independently installable Koishi plugin usable in ordinary Node.js deployments; R2 remains optional, while enabling it requires a complete credential set and incomplete configuration fails during startup.
