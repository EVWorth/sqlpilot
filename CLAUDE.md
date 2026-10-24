@AGENTS.md

# Claude Code setup

`AGENTS.md` above holds the project, commands, gates and rules every agent
follows. This part covers what is specific to Claude Code. Folder conventions
load on their own from [`src/CLAUDE.md`](src/CLAUDE.md) and
[`src-tauri/CLAUDE.md`](src-tauri/CLAUDE.md) when work touches those folders.

## Working agreements

From the maintainer, in addition to the rules in `AGENTS.md`. Follow them
without asking again.

- **"Release" means ship it, end to end.** Use the `release` skill. Don't stop
  to ask which version or whether to go ahead.
- **Write lasting instructions down.** When the maintainer sets a rule for how
  to work, add it to `AGENTS.md` (any agent) or this file (Claude only) in the
  same session. Put a procedure in a skill instead.

## Skills

Procedures live in `.claude/skills/<name>/SKILL.md`. Each one loads when its
task comes up, or by `/<name>`.

| Skill               | Use it to                                                         |
| ------------------- | ----------------------------------------------------------------- |
| `release`           | cut a release: bump, release PR, tag, publish the draft           |
| `add-tauri-command` | add or change a Tauri command across Rust, bindings, API and mock |
| `integration-tests` | run the database-backed Rust tests against MySQL and MariaDB      |
| `ui-preview`        | see or screenshot the UI with the mock backend                    |
| `file-issue`        | file an issue for something wrong you found                       |
| `findissues`        | scan the codebase and file issues for what it finds               |
| `reviewissues`      | triage open issues into a prioritized report                      |
| `review-prs`        | review an open PR with the `reviewer` agent                       |
| `doc-keeper`        | run a docs drift sweep and open a PR                              |

## Subagents

The main session is the team lead: it dispatches, verifies and owns design
decisions. Subagents in `.claude/agents/` get their own context, so use them
for work that reads a lot and reports a little, or to run lanes in parallel.
For "where does X live" use the built-in Explore agent.

| Agent                  | Use for                                    | Edits             |
| ---------------------- | ------------------------------------------ | ----------------- |
| `implementer-frontend` | React/TS features, stores, types, tests    | `src/` only       |
| `implementer-rust`     | Tauri commands, crates, Rust tests         | `src-tauri/` only |
| `reviewer`             | diff review against `REVIEW.md`            | none              |
| `ci-doctor`            | triage a failing CI run from its logs      | none              |
| `doc-keeper`           | docs drift: `docs/`, README, `AGENTS.md`   | docs only         |
| `issue-reviewer`       | issue triage (run through `/reviewissues`) | none              |

When a subagent did the work, say so. Don't present a general-purpose agent's
output as a specialist's. Design questions stay with the team lead.

Parallel subagents each get their own `git worktree`. Tell them never to use
`git stash`: the stash list is shared by every worktree, so one agent's
`stash pop` takes another's changes (the permission settings deny it). To test
that a fix is needed, save a patch with `git diff > file` and reverse-apply it.

## File ownership

| Path                                                                        | Owner                                        |
| --------------------------------------------------------------------------- | -------------------------------------------- |
| `src/`                                                                      | implementer-frontend                         |
| `src-tauri/` (including `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`)      | implementer-rust                             |
| `docs/`, `README.md`, `CONTRIBUTING.md`                                     | doc-keeper (substantial rewrites: team lead) |
| `package.json`, `package-lock.json`                                         | implementer-frontend                         |
| version fields in the three manifests                                       | `release` skill                              |
| `.github/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, root configs | team lead                                    |

Cross-lane edits need the team lead's approval.

## Output style

Terse chat. Drop filler and pleasantries; fragments are fine
(`[thing] [action] [reason]. [next step].`). Correctness beats terseness.
Code, commits, PRs, issues and log lines are written in normal English.

## Cloud sessions

- The session pushes only to its own branch. **Tag pushes get HTTP 403**, and
  the GitHub tools cannot create tags or publish releases; the `release` skill
  covers the hand-off.
- GitHub deletes the session branch when its PR merges. Recreate it from
  `origin/main`.
- The disk fills quickly with test binaries. Before a long Rust run, delete
  `src-tauri/target/debug/incremental` and large files in
  `src-tauri/target/debug/deps`, and set `CARGO_INCREMENTAL=0`.
- Docker doesn't survive a container restart: start `dockerd`, then
  `just db-up`.
- The session-start hook sets `CHROMIUM_PATH` to the container's Chromium, so
  `npm run test:browser` works as is. Run browser test files one at a time if
  the full suite times out.
