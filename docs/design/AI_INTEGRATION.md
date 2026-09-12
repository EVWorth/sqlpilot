# AI Integration — Design

**Status:** Draft, for review\
**Supersedes:** the `mas-ai` crate and ADR-007's embedded-provider design\
**Companion ADR:** ADR-011 in [TECH_DECISIONS.md](TECH_DECISIONS.md)

---

## 1. What this is

SQLPilot does not call a model. It exposes a database, safely, to whatever
agent the user already runs and pays for — **bring your own harness**.

The old design had SQLPilot holding a Copilot SDK session, a system prompt, and
a set of tools it called on the model's behalf. That meant owning credentials,
a provider abstraction, rate limiting and token budgets, and a system prompt
that untrusted schema text was injected into. The user's decision is to own
none of it.

Inverting the relationship removes all of that at once. What remains is the
part SQLPilot is uniquely placed to do: **be the policy boundary between an
agent and a live database.**

### Goals

- Any MCP-speaking harness can use the user's live connections, under
  SQLPilot's row limits, query timeouts, production guard and data policy.
- A session can be attached **inside the app**, seeing the active tab and
  proposing edits to it — the Copilot-in-VS-Code shape, for SQL.
- No credentials, no model API calls, no token accounting anywhere in this
  codebase.

### Non-goals

- Hosting or proxying a model.
- Inline AI completions in the editor. Those need an in-process, low-latency
  model call. Autocomplete stays schema-driven.
- Being a generic MySQL MCP server. The value is the policy layer and the app
  awareness; without a running SQLPilot there is nothing here.

---

## 2. The keystone decision

> **Approval for a destructive action happens in SQLPilot's own window, always,
> whatever harness is driving.**

Harnesses have escape hatches. Copilot CLI has `--allow-all` and `--yolo`;
Claude Code has `--permission-mode` and `--allowedTools`. Any design that
relies on the harness to ask the user is one flag away from not asking.

So the tool implementation blocks on SQLPilot's own confirmation — the same
`confirmDestructive` dialog the grid, the restore and the schema tree already
use, showing the exact statement, the environment badge, and a dry-run
affected-row count. The harness's own prompt, where it has one, is a second
gate we are happy to have and never the only one.

This is only possible because of BYOH. An embedded agent would have had to
invent its own approval UI; as a tool provider we get to reuse the one the app
already has, which the user already trusts for the same actions.

---

## 3. The three planes

| Plane            | What it is                                               | Depends on a harness? |
| ---------------- | -------------------------------------------------------- | --------------------- |
| **Tool surface** | The MCP server: what an agent can see and do             | No                    |
| **Policy**       | What is allowed, from whom, on which connection          | No                    |
| **Session**      | Attaching a harness in-app: transcript, approvals, diffs | Yes, one adapter each |

Everything valuable is in the first two. The session plane is a launcher and a
viewer; if a harness changes its CLI we lose a view, not the product.

---

## 4. Tool surface

Grouped by what leaves the machine, because that is what the policy grades.

### 4.1 Shape — names, types, relationships

No row data. Available at every posture, on every connection.

| Tool               | Arguments                                  | Returns                                                                                                                                                           |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_connections` | —                                          | Live connections: id, name, server version, environment, read-only flag, current database. How a session knows what it may attach to                              |
| `list_databases`   | `connection`                               | Names, charset, collation                                                                                                                                         |
| `list_tables`      | `connection`, `database`                   | Name, engine, approximate rows, size, comment                                                                                                                     |
| `describe_table`   | `connection`, `database`, `table`          | Columns (name, type, nullable, default, extra, comment), primary key, indexes, foreign keys **in both directions**                                                |
| `get_ddl`          | `connection`, `database`, `object`, `kind` | `SHOW CREATE` output for a table, view, routine or trigger                                                                                                        |
| `list_objects`     | `connection`, `database`, `kind`           | Views, routines, triggers, events                                                                                                                                 |
| `related_tables`   | `connection`, `database`, `table`, `depth` | A walk of the foreign-key graph. Answers "how do I get from `orders` to `customers`", which is the first question anyone has about a database they did not design |
| `search_schema`    | `connection`, `query`                      | Tables and columns matching a fragment. **The retrieval primitive** — an agent greps the schema rather than being handed 500 tables it cannot fit                 |

`search_schema` and `related_tables` exist so that nothing ever has to dump a
whole schema into a context window. A 500-table database is the normal case,
and a truncated dump is how a model confidently invents a column.

### 4.2 Analysis — numbers about data, not the data

| Tool              | Arguments                                   | Returns                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explain`         | `connection`, `sql`, `format`               | The plan, in classic / JSON / tree form. Goes through the existing `explain` path, so ANALYZE's write-refusal and the MariaDB format fallbacks apply unchanged                                                        |
| `table_stats`     | `connection`, `database`, `table`           | Row estimate, data and index size, auto-increment position, fragmentation                                                                                                                                             |
| `profile_column`  | `connection`, `database`, `table`, `column` | Count, distinct count, null rate, min/max, and for numeric or temporal columns a distribution. **Computed in the database**: the aggregate leaves, the rows do not. Top-N values only where the posture allows values |
| `estimate_impact` | `connection`, `sql`                         | For a write: runs it inside a transaction, reports the affected row count, rolls back. This is what makes "this will update 1 row" and "this will update 4.2 million rows" look different in the confirmation         |

This group is the reason an agent attached to SQLPilot can be more useful than
one with a connection string: it can measure before it acts, and it can answer
questions about data without reading data.

### 4.3 Query

| Tool         | Arguments                     | Enforced                                                                                                                                                                                                                                     |
| ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_select` | `connection`, `sql`, `limit?` | **Single statement** — the SQL is split and refused if it is more than one. Verb checked with `effective_verb`, so `WITH … DELETE` is not a read. Row cap and query timeout from the connection. Redaction and posture applied to the result |
| `run_write`  | `connection`, `sql`           | Single statement. `estimate_impact` first. Approval in SQLPilot's window. Executed inside a transaction the app can roll back. Refused outright on a read-only profile — the executor already refuses, this is the second lock               |
| `run_ddl`    | `connection`, `sql`           | As above, and refused by default on production                                                                                                                                                                                               |

The multi-statement rule is the lesson of the old implementation, which checked
`sql.to_uppercase().starts_with("SELECT")` on the whole string and then handed
it to an executor that splits on `;`. `SELECT 1; DROP TABLE users` passed the
read-only tool. The splitter and `effective_verb` that make this correct
already exist, tested, in `mas-core::query`.

### 4.4 App awareness — what makes this a client, not a driver

| Tool                 | Arguments                 | Returns / effect                                                                                                     |
| -------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `get_editor_context` | —                         | Active tab's SQL, the selection, its connection and database                                                         |
| `get_result_context` | —                         | Columns, row count, execution time and truncation of the result on screen. Rows only under posture                   |
| `get_last_error`     | —                         | The last execution error, with its statement, code and SQLSTATE                                                      |
| `propose_edit`       | `tab`, `sql`, `rationale` | Shows a **diff** on that tab. Returns whether the user accepted, rejected, or edited it first. Never writes silently |
| `open_draft`         | `sql`, `title`            | Opens a new tab. Never overwrites what the user typed                                                                |
| `query_history`      | `filter`                  | Past statements, redacted per settings, so the agent can see what has been tried                                     |

`propose_edit` is the single most important tool in the document. It is the
inline-diff surface that makes an editor agent feel native, and the reason the
in-app session is worth building rather than telling people to use a terminal.

### 4.5 Resources and prompts

MCP's other two primitives, used as intended:

- **Resources** — the attached database's schema as a browsable tree, and the
  active tab, so a harness can offer them as `@`-mentions without a tool call.
- **Prompts** — "optimise this query", "explain this schema", "write the
  migration for…", "why did this fail" — the workflows worth having a name.

---

## 5. Policy

Three axes decide every call. All three already exist in the app; none of them
is new machinery.

**Data posture**, per connection profile:

| Posture                               | What a tool may return                                               |
| ------------------------------------- | -------------------------------------------------------------------- |
| `schema-only` (default on production) | Names, types, relationships, and aggregates. No row values, no top-N |
| `samples`                             | Up to N rows, redacted, for tables the user has allowed              |
| `full`                                | Rows up to the connection's row cap, redacted                        |

Redaction is by column name or pattern, configured per profile. The posture is
shown in the session header, always visible, because a user needs to know what
the thing attached to their production database is allowed to see.

**Environment**, from the profile's existing `environment` field.

**Verb class**, from `effective_verb` and `isDestructiveStatement`.

Together:

|                             | development | staging     | production                                            |
| --------------------------- | ----------- | ----------- | ----------------------------------------------------- |
| shape and analysis          | auto        | auto        | auto                                                  |
| `run_select`                | auto        | auto        | auto, `schema-only` posture by default                |
| `run_write`                 | ask         | ask         | ask, with dry-run count, per statement                |
| `run_ddl`                   | ask         | ask         | **refused** unless the session is explicitly unlocked |
| admin (users, grants, kill) | not exposed | not exposed | not exposed                                           |

A read-only profile refuses every write regardless, in the executor, before
the batch is assembled — that is existing behaviour and the agent path inherits
it rather than re-implementing it.

Sessions may attach to production. That is a deliberate product decision, and
it is why the approval model above is load-bearing rather than decorative.

---

## 6. Sessions

A session is a harness process attached to a connection and a database.

- It gets **its own pooled connection**, its own query timeout and its own
  grants, so a runaway agent query cannot starve the user's own pool.
- Grants are per session and expire with it. "This session may read values from
  `customers`" is a thing the user says once, to one session, not a global
  setting they forget about.
- It is **cancellable**, and cancelling issues `KILL QUERY` for anything in
  flight — abandoning the future is what #658 was about.
- Several may run at once. Background work ("find out why the nightly job is
  slow") reports progress and surfaces when it needs an answer.
- Everything it runs lands in query history tagged with the session and the
  harness, so **"what did this thing do"** is answerable afterwards — and
  **"undo what this session did"** is offered where the statements were
  transactional.

### Long-running work

MCP's [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
(spec revision 2026-07-28) is the right mechanism for anything slow: the server
returns a durable handle instead of blocking, the client polls, and a task that
needs a human moves to `input_required`. That maps exactly onto a write waiting
for approval in SQLPilot's window — the harness is told "waiting on the user"
rather than holding a connection open until it times out.

Support is per-client, so tools must work without it: block, and let the
harness's own timeout be the harness's problem.

---

## 7. Harness adapters

Verified 2026-09-12 against current docs. **These surfaces move; re-check
before building against them.**

### What both have

Both configure MCP servers as an `mcpServers` object, support Streamable HTTP
with `Authorization` headers, and have non-interactive add commands
(`claude mcp add --transport http …`, `copilot mcp add --transport http …`).
Both read a project `.mcp.json`.

So SQLPilot runs a **loopback HTTP MCP server with a bearer token**, and
exports the one-line command for each. stdio does not fit: the server must live
inside the running app to reach live connections, not be spawned by the harness.

### Claude Code — full in-app session

The CLI has everything a host needs:

| Need                    | Mechanism                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Structured transcript   | `-p --output-format stream-json --verbose --include-partial-messages` — NDJSON of `system/init`, assistant/user messages, deltas, and a final `result` |
| Wire in our server      | `--mcp-config <file-or-json>`, without touching the user's global config                                                                               |
| **Approvals in our UI** | `--permission-prompt-tool`, an MCP tool that answers permission requests — so SQLPilot renders the prompt natively                                     |
| Multi-turn              | `--resume <session_id>`, or `--input-format stream-json`                                                                                               |
| Cancel a turn           | SIGINT ends the turn; SIGTERM leaves it unfinished (exit 143)                                                                                          |

Two constraints worth writing down:

- **Do not pass `--bare`.** Bare mode does not read the subscription login and
  expects `ANTHROPIC_API_KEY` — which is precisely the thing we refuse to
  handle. Running without it means the session also loads the working
  directory's hooks, MCP servers and memory, so the session must be launched in
  a **controlled working directory**, not wherever the user happens to be.
- **Do not embed the Agent SDK.** Anthropic's terms do not permit third-party
  products to offer claude.ai login through it; it expects an API key. Spawning
  the user's own authenticated CLI is what keeps this BYOH. Branding guidance
  also rules out labelling anything "Claude Code" in our UI — "Claude Agent" or
  "Powered by Claude" are the permitted forms.

### GitHub Copilot CLI — MCP now, session view when it can

Copilot CLI has `-p`, `--resume`, `--continue`, and MCP configuration, but the
public documentation describes **no structured streaming output and no
permission-host callback** — only `--allow-all` / `--yolo`. So:

- **Slice 1 is complete for Copilot today**: the MCP server works in the CLI
  and in VS Code, under our policy.
- **The in-app view for Copilot** starts as an embedded terminal (PTY) rather
  than a native transcript, and upgrades if a structured mode appears.
- `--yolo` is exactly why §2 exists. Our approvals do not care.

---

## 8. What ships in what order

1. ~~**MCP server + policy engine + config export.**~~ **Shipped.** The
   `mas-mcp` crate: the policy, the statement classifier, grants, twelve tools
   (shape, analysis, and `run_select`), and a loopback endpoint behind a bearer
   token, with Settings → Agents to share connections and hand over the setup
   command. Writes and schema changes are refused with a sentence pointing at
   what does work.
2. **In-app sessions**, Claude Code natively and Copilot in a terminal view,
   with the app-aware tools — `propose_edit` is what makes this worth doing.
3. **Writes**: dry-run, graded approval, transaction wrapping, undo.
4. **Background and multi-session.**

Reads before writes, even in-app. A session that can only look is a useful
product and a much smaller blast radius.

---

## 9. Open questions

1. **Transport.** Settled in part: loopback HTTP, bearer token in a 0600 file
   in the data directory, rotation from Settings → Agents which restarts the
   endpoint so the old token stops working immediately. **Still open:** two
   SQLPilot windows. The second loses the preferred port and takes an
   ephemeral one, so both serve and a harness config points at whichever
   started first.
2. ~~**Identity of a "connection" across restarts.**~~ **Settled: profile id.**
   An agent addresses a connection by the id of the saved profile, which
   survives restarts, and the app translates to the per-session connection id
   at the workspace boundary. A shared profile that is not connected right now
   has a policy and a refusal that says "not connected" rather than "not
   found" — the agent has the id because the user shared it, so "no such
   connection" would send it hunting for a typo.
3. **What the agent is told about policy.** Tool descriptions are read by the
   model; a refusal should teach it what to do instead ("this connection is
   schema-only; use `profile_column`") rather than just failing.
4. **Sampling grants.** Per table, per column, or per session? Per table is
   probably right; per column is where redaction already lives.
5. **Does `run_ddl` exist at all in v1?** The migration workflow wants it. The
   table designer already produces reviewed DDL, and `propose_edit` plus a
   draft tab may be the better shape — the agent writes the migration, the
   user runs it.
