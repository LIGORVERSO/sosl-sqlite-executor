# SOSL SQLite Executor

Public technical executor for the SOSL SQLite update path.

## Current state

`v0.1.0` is deliberately limited to an isolated runner probe.

It proves only:

- standard public GitHub-hosted runner;
- Node.js 24;
- built-in `node:sqlite`;
- SQLite FTS5 + `bm25`;
- transaction rollback;
- `PRAGMA integrity_check`.

It does **not** contain:

- Ligorverso canonical material;
- SQLite snapshots;
- Google Drive credentials;
- tokens or private configuration;
- automatic schedules;
- push-triggered rebuilds;
- Drive read/write logic.

## Trigger

The only workflow trigger in v0.1.0 is `workflow_dispatch`.

The observer/control-plane is external and is not part of this public repository.

## Security boundary

Never commit secrets or canonical content here. Future Drive credentials, if authorized,
must live only in GitHub Actions Secrets and must be scoped to the minimum files/actions required.

No artifacts or dependency caches are used by the probe.
