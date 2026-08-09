---
status: accepted
---
# Model Works as ordered media collections

Archive v2 models a Work as searchable metadata plus at least one ordered Media Item, with each Media Item belonging to exactly one Work; a lightweight relationship record carries ownership and display order while Payload Media owns the file metadata. The first supported Work media types are images and PDFs, Paper remains a separate PDF Newspaper Issue, and the ZIP Work Package model is removed. This decision supersedes ADR 0008 for Archive v2.
