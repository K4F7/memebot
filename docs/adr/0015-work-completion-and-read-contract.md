---
status: accepted
---
# Define Work completion and the Archive read contract

`Media.work` is the ownership fact: each Media Item must be assigned to exactly one Work at upload time and cannot be rebound to another Work afterward. `WorkMedia` is the presentation relationship and carries a unique non-negative display order, normalized to a contiguous sequence starting at zero during the write transaction, plus an optional caption; it must agree with the Media ownership and a Media Item can appear in only one relationship. A Media Item may exist before its WorkMedia presentation relationship is created, but it is not readable until that relationship is valid.

Under the superseded MVP rule, a Work became readable when it had at least one valid WorkMedia
relationship to a non-withdrawn Media Item. ADR 0017 replaces that rule: only an explicitly
published Work version whose complete ordered manifest contains at least one readable Media Item
is returned by the Archive Read Contract. A draft-only or empty Work returns not-found while its
record and Archive Identifier remain reserved. The R2 object is checked when the protected media
request is served, not while listing the Work. Published Media physical deletion is not part of the
MVP, and delete access is disabled for Work, Media, and WorkMedia. The authoring boundary may remove
a never-published draft Media Item after recording a retryable cleanup intent. Any authenticated
Archive Administrator may set `withdrawnAt` on an erroneous published Media Item instead: its
metadata and private R2 object remain retained, published reads exclude it, and restoration is a
later lifecycle capability. Archive Identifiers remain stable.

Media filenames are display metadata, not identity, and different Media Items may use the same filename. Storage uses a separately generated internal object key that is retained with the Media record; a filename must never be used as the durable identity of an R2 object.

The canonical machine contract is `GET /api/archive/v1/works?query=&author=`, `GET /api/archive/v1/works/:archiveId`, and the signed `GET /api/archive/v1/media/:mediaId?expires=&signature=` endpoint. Search returns `{ data, total }`, where `total` is the exact number of matches and `data` is capped at 1000 items in the MVP; Work detail returns `{ data }`, and the first two endpoints require the dedicated machine credential. Compatibility aliases may remain for one Koishi release cycle after the client switches to the canonical contract, then they are removed.

The current implementation still contains compatibility aliases and legacy collection surfaces; this
ADR records the target domain behavior, not an accidental promise made by those defaults.
