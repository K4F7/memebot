---
status: accepted
---
# Define Work completion and the Archive read contract

`Media.work` is the ownership fact: each Media Item must be assigned to exactly one Work at upload time and cannot be rebound to another Work afterward. `WorkMedia` is the presentation relationship and carries a unique non-negative display order, normalized to a contiguous sequence starting at zero during the write transaction, plus an optional caption; it must agree with the Media ownership and a Media Item can appear in only one relationship. A Media Item may exist before its WorkMedia presentation relationship is created, but it is not readable until that relationship is valid.

In the MVP, a Work becomes readable when it has at least one valid WorkMedia relationship to a non-withdrawn Media Item; a Work with no readable Media Items returns not-found while its record and Archive Identifier remain reserved. The R2 object is checked when the protected media request is served, not while listing the Work. Physical deletion is not part of the MVP, and delete access is disabled for Work, Media, and WorkMedia. Any authenticated Archive Administrator may set `withdrawnAt` on an erroneous Media Item instead: its metadata, WorkMedia relationship, and private R2 object remain retained, reads exclude it, and restoration is a later lifecycle capability. Archive Identifiers remain stable.

Media filenames are display metadata, not identity, and different Media Items may use the same filename. Storage uses a separately generated internal object key that is retained with the Media record; a filename must never be used as the durable identity of an R2 object.

The canonical machine contract is `GET /api/archive/v1/works?query=&author=`, `GET /api/archive/v1/works/:archiveId`, and the signed `GET /api/archive/v1/media/:mediaId?expires=&signature=` endpoint. Search returns `{ data, total }`, where `total` is the exact number of matches and `data` is capped at 1000 items in the MVP; Work detail returns `{ data }`, and the first two endpoints require the dedicated machine credential. Compatibility aliases may remain for one Koishi release cycle after the client switches to the canonical contract, then they are removed.

The current implementation still contains compatibility aliases, delete access, filename-based object lookup, and lacks withdrawal/order-normalization fields that must be aligned in follow-up changes; this ADR records the target domain behavior, not an accidental promise made by those defaults.
