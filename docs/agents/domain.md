# Domain Docs

This repository uses a single-context domain documentation layout.

## Before exploring

Read the following documentation relevant to the work:

- `CONTEXT.md` at the repository root
- Applicable ADRs under `docs/adr/`

If either location is absent, proceed silently. Domain documentation and ADRs are created when terminology or architectural decisions are actually resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── plugins/
```

All standalone plugins share the vocabulary in the root `CONTEXT.md`. Do not create separate, conflicting definitions of shared concepts inside individual plugin packages.

## Vocabulary

Use the terms defined in `CONTEXT.md` in issue titles, specifications, tests, implementation, and documentation.

If a required concept is missing, reconsider whether new terminology is necessary. Record genuine terminology gaps through the domain-modeling workflow.

## ADR conflicts

If proposed work contradicts an existing ADR, identify the conflict explicitly rather than silently overriding the decision.
