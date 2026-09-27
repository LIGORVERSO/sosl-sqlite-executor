# GIL Apps Script Observer v0.2.1

Event-driven control plane for SOSL SQLite banks.

Normal path:
15-minute installable trigger -> Drive changes.list -> 10-minute quiet-period eligibility -> GitHub workflow_dispatch.

Semantics:
- `poll_interval_minutes` remains 15. The trigger is the only operational clock.
- `debounce_minutes` is now a true quiet period: the latest relevant source `modifiedTime` must be at least this old before dispatch. Target value: 10 minutes.
- New source changes replace the observed revision and move the quiet-period anchor forward.
- Dispatch happens only on a normal observer cycle; there is no separate timer.
- The same dirty revision set is not dispatched again while waiting for ACK.
- `redispatch_timeout_minutes` is a fail-safe retry window for an identical unacknowledged revision set. Default: 45 minutes.
- A different revision signature can become eligible after its own quiet period.
- Exact-revision ACK behavior remains unchanged.
- Apps Script never processes SQLite.
- GitHub token lives only in Script Properties as `GITHUB_FINE_GRAINED_TOKEN`.
- `observerProbe` never dispatches.
- DRY_RUN or `dispatch_enabled=FALSE` prevents dispatch.
- `installObserverTrigger15m` keeps exactly one `observerRun` trigger.
