<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project Context

This project is an FYP prototype for database schema comparison and related database-management workflows.

Current week-7 priority:
- The main deliverable is the `/compare` flow.
- It must work as a real PostgreSQL schema comparison prototype, not just a mock UI.
- It compares exactly two schemas at a time from preset live database targets.
- It currently focuses on diff reporting, not SQL generation or deployment.


Current compare scope:
- Tables
- Columns
- Column order
- Data types
- Nullability
- Primary keys
- Unique constraints
- Foreign keys
- Check constraints
- Exclude constraints
- Similarity-based rename suggestions for tables and columns

# Project Rules

- Treat `/compare` as the flagship feature and preserve its end-to-end usability.
- Keep PostgreSQL introspection logic in `lib/postgres.ts`.
- Keep pure comparison and scoring logic in `lib/compare.ts`.
- Prefer improving the existing compare workflow over introducing new unfinished modules.
- Do not replace the preset env-based target approach unless explicitly requested.
- Preserve support for `DATABASE_URL`, `DATABASE_URL_A`, `DATABASE_URL_B`, `COMPARE_DATABASE_A`, and `COMPARE_DATABASE_B`.
- Preserve the current query-param driven compare selection: `leftDb`, `leftSchema`, `rightDb`, `rightSchema`.
- When changing constraint handling, normalize DB output defensively before diff logic uses it.
- Keep error states user-readable on `/compare`; database or schema issues should surface as clean messages, not crashes.
- Favor simple, readable code over clever abstractions. This project is maintained by a beginner.

# Deferred For Now

Unless explicitly requested, do not treat these as in-scope:
- Auth
- GitHub push flow
- Migration execution
- SQL generation
- Version-control workflow
- Docker/compliance cleanup
- Query analysis
- Performance monitoring features
