---
paths:
  - "package.json"
  - "package-lock.json"
  - ".nvmrc"
  - ".claude/hooks/**"
---

# Cloud session setup

- A Claude Code cloud session starts on Node 22 and npm 10, which cannot `npm ci` this lockfile. `.claude/hooks/session-start.sh` (a SessionStart hook) installs the Node in `.nvmrc` from nodejs.org, checks its SHA-256, puts it on PATH and runs `npm ci`. It does nothing locally. Fix a cloud failure there, not in package.json.
