# rave

Synchronized peer-to-peer audio rooms — one person creates a room and adds tracks to its
playlist, others join from the room list or with a room code, and every device plays the
same track at the same instant.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `vadodariyakeyur/rave` via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` (what the system is and how it behaves), `GLOSSARY.md` (the
terms, and the ones to avoid) and `docs/adr/` at the repo root. These are the source of truth
for anything about the project: read them first, use the glossary's words, and if the code
disagrees, say so rather than picking one silently. See `docs/agents/domain.md`.
