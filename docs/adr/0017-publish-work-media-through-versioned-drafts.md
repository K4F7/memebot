---
status: accepted
---
# Publish Work metadata and media through one versioned draft

The Work Authoring API is the only write boundary for a Work and its ordered Media
presentation. A newly created Work is a private draft with a stable Archive Identifier.
The ordered media manifest, captions, filenames, and Work metadata are stored together
in the Work draft/version value; Payload collection REST writes are not an alternative
authoring contract.

Image and PDF bytes continue to use the existing short-lived, signed direct-to-R2 upload
path. Each upload is registered against the draft, finalized by an idempotent request, and
addressed by an immutable opaque storage key. Replacing a file creates a new Media Item and
changes the draft manifest only after the new object is verified. Never-published draft
items may be discarded after their database references are removed; cleanup intents are
durable and R2 deletion is retried outside the database transaction.

Every aggregate mutation carries an opaque optimistic revision. A stale revision returns a
conflict without mutation. Publishing takes a per-Work PostgreSQL transaction lock, checks
the complete draft (metadata, ordered manifest, readable finalized media, and no pending
uploads), and promotes the draft through Payload's publish operation. A failed promotion
rolls back, preserving both the previous published snapshot and the complete retryable
draft.

The Archive Read Contract requests only the published Work document and its published
manifest. Draft creation, uploads, saves, replacements, and failed publications therefore
remain invisible to QQ readers until an explicit successful publish. The public Archive
identifier and protected media URL contract remain unchanged.
