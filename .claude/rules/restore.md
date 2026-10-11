---
paths:
  - "docs/backups.md"
  - "src/backup.ts"
  - "scripts/dump-invariants.mjs"
  - ".github/workflows/**"
---

# Restore

`wrangler d1 export` fails on this database because of FTS5. Follow the per-table procedure in `docs/backups.md`: import `documents` first, and never export `documents_fts`. The weekly `restore-rehearsal.yml` runs d1-dump's drill (`npx d1-dump drill`) plus `scripts/dump-invariants.mjs`; it restores into a local SQLite file and holds no Cloudflare credential, and none is to be added to that workflow (Dustin, 2026-10-05: a D1 Edit token covers every database in the account). The drill against a real D1 database is run by hand, quarterly.
