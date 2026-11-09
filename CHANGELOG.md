## v1.5.0 (2026-11-09)

### Feat

- let the standalone exe replace itself when it updates (#955)
- **sqlite**: transaction state per connection (#941)
- mock backend gaps; components go via stores (#918)
- report completed results and transaction state (#916)
- UX review fixes for connections and app shell (#891)
- UX review fixes for schema tree and designer (#888)
- UX review fixes for admin, history and agent panel (#886)

### Fix

- keep queries running if sysinfo cannot read memory (#956)
- reported tx state on failure; bind new tabs (#943)
- SQLite scripts, safe schema reads, row cap (#934)
- hook deps without exhaustive-deps disables (#931)
- SQLite foreign keys, mock version, import deps (#927)
- keep results on timeout; restore and startup bugs (#926)
- grid cell keys, tx switch prompt, CSV import (#922)
- in-flight key, staged write timeout, test seeds (#915)
- **ux**: editor, grid and results review fixes (#908)
- F5 refreshes the schema everywhere, never reloads (#907)
- cancel reaches staged writes; shared test DBs (#900)
- history count on delete, SQLite Design Table, tests (#899)
- build the macOS menu from the action list (#897)
- show hover-only controls on keyboard focus (#896)
- stop the agent's SQL on cancel, and name who asked (#893)
- credential follow-ups from the log redaction (#885)
- credentials, CSP and CI gaps from the docs review (#880)
