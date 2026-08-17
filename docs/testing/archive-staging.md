# Archive staging operating note

Historical Payload VPS staging notes no longer apply on `main`. The frozen
Payload application and its staging smoke path live on `archive/payload-cms` at
`9804752f2d7e6d5957a5ce47c8872750bde988ce`.

This repository no longer starts Payload or a PostgreSQL service for Archive.
QQ read verification is the fail-closed command surface in
[`archive-qq-shortcuts.md`](archive-qq-shortcuts.md).
