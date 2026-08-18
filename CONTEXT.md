# Domain Glossary

## Submission

Content a user sends to the club for review, possible publication, or further handling. A submission is not automatically public.

## Question

A request for a direct answer from the club or its maintained FAQ. Questions may remain unanswered until a maintainer responds.

## Discussion

A topic opened for members to exchange views. Unlike a question, a discussion does not require one authoritative answer.

## Answer

An authoritative response maintained by the club for a question. Reusable answers may become FAQ entries.

## Suggestion

A proposal to change or improve the club, its activities, publications, or services.

## Feedback

An account of a user's experience, observation, or problem that the club may review and respond to. Unlike a suggestion, feedback does not need to propose a change.

## Intake Draft

Feedback, a suggestion, or a submission being collected from a user but not yet submitted for handling. A draft is not an intake record and has no tracking number or review status.

## Intake Record

Submitted feedback, suggestion, or other intake content tracked under a stable number for administrative handling. Its handling progress is distinct from whether it remains active in the administrators' work queue.

## Intake Identifier

A stable public reference assigned within one intake type when a draft is submitted. It is never reused and remains attached to the record throughout its handling history.

## Intake Assignee

The administrator currently responsible for following up an intake record outside the bot. Assignment acknowledges that the record has been seen but does not itself decide or close the record.

## Activity

A scheduled club event with a title, time, status, and optional location or reference link. A recent activity is upcoming or currently active, not merely recently published.

## Newspaper Issue

One historical issue of the club newspaper. It has searchable metadata, a PDF publication, and may have a source-code or source-material link.

## Work

A historical club or member work represented by searchable metadata and one or more Media Items. A Work is readable only when it has at least one valid WorkMedia Relationship to a non-withdrawn Media Item, and its Archive Identifier is never reused.

## Media Item

A file owned by exactly one Work, such as an image or PDF. Its filename, media type, and size describe the file; presentation order and captions belong to its WorkMedia Relationship, and filenames need not be unique across Media Items.

## WorkMedia Relationship

The relationship that presents one Media Item in one Work. It carries a unique display order normalized from zero without gaps and an optional caption, must agree with the Media Item's owning Work, and a Media Item may appear in at most one relationship.

## Withdrawn Media Item

A Media Item intentionally excluded from Archive reads while its metadata and private object are retained. Withdrawal is not physical deletion, and restoration is a later lifecycle capability.

## Publication Appearance

The occurrence of a work in a newspaper issue, optionally identified by a page or section. A work may appear in multiple issues, and an issue may contain multiple works.

## Archive Identifier

A stable public reference assigned to one newspaper issue or work. It remains associated with that item throughout its archive lifetime and is never reused.

## Archive Read Contract

The machine-facing `/api/archive/v1` boundary through which Koishi searches Works, retrieves Work details, and requests protected Media Items. `memebot-archive` binds this contract when origin and machine credential are configured. It is separate from any content-platform administration surface.

## Archive Administrator

A content-platform identity authorized to manage Archive records outside QQ. This identity is not a QQ identity, is not PayloadCMS, and does not grant memebot-access authorization.

## Help Document

The maintained user-facing guide to the bot's commands and supported workflows. It may be requested explicitly or sent after a poke interaction.

## Plugin Administrator

A QQ user authorized through the central authorization source to manage every protected plugin. A management group limits where management actions may run; membership in that group does not itself grant administrator status.

## Management Group

A QQ group in which plugin administrators may perform state-changing management actions. It does not limit ordinary service use or administrator-only reads, grant administrator status to group members, or imply that operational notifications are sent there.

## Notification Group

A QQ group selected to receive operational notifications, such as newly submitted intake records. Receiving notifications does not make it a management group or grant any administrative authority to its members.
