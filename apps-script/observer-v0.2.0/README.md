# GIL Apps Script Observer v0.2.0

Event-driven control plane for SOSL SQLite banks.

Normal path:
15-minute installable trigger -> Drive changes.list -> dirty/debounce -> GitHub workflow_dispatch.

Important:
- Apps Script never processes SQLite.
- GitHub token lives only in Script Properties as GITHUB_FINE_GRAINED_TOKEN.
- Fine-grained token is restricted to LIGORVERSO/sosl-sqlite-executor with Actions: write.
- The control sheet contains no secret.
- First v0.2 cycle performs one revision reconciliation so migration from v0.1 cannot miss existing deltas.
- After migration, ordinary observation uses changes.list rather than scanning all sources each cycle.
- observerProbe never dispatches.
- DRY_RUN or dispatch_enabled=FALSE prevents dispatch.
- installObserverTrigger15m removes possible v0.1 observerProbe triggers and creates exactly one observerRun trigger.
