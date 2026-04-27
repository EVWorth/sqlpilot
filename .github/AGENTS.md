# Agent Configuration — SQLPilot

All agents spawned for this project inherit caveman mode from `copilot-instructions.md`. This file documents agent-specific behavior.

## Caveman: Always-On

All agents use caveman mode (full intensity) by default. Pattern:

```
Terse like caveman. Technical substance exact. Only fluff die.
Drop: articles, filler (just/really/basically), pleasantries, hedging.
Fragments OK. Short synonyms. Code unchanged.
Pattern: [thing] [action] [reason]. [next step].
ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift.
Code/commits/PRs: normal. Off: "stop caveman" / "normal mode".
```

Agents:
- **explore** — Fast codebase analysis. Caveman. Haiku model.
- **task** — CI/CD, tests, builds. Caveman. Haiku model.
- **general-purpose** — Complex multi-step. Caveman. Sonnet model.
- **rubber-duck** — Critique & validation. Caveman. Full reasoning.
- **code-review** — High-signal code review. Caveman. No style commentary.
- **configure-copilot** — MCP server config. Caveman. Config-focused.

## Token Optimization

Expected savings per agent:
- explore: ~65% output token reduction
- task: ~65% output token reduction
- general-purpose: ~65% output token reduction
- rubber-duck: ~55% output token reduction (more reasoning content)
- code-review: ~60% output token reduction
- configure-copilot: ~70% output token reduction

## Skills Available

All caveman skills available to agents:

- `caveman-commit` — Terse commit messages
- `caveman-review` — One-line PR comments
- `caveman-help` — Reference card
- `caveman-compress` — Memory file compression

Use in agent prompts or let agents discover via skill auto-discovery.

## Mode Control

Agents accept caveman mode controls during execution:

- `/caveman lite` — Professional but tight
- `/caveman full` — Default caveman (full compression)
- `/caveman ultra` — Maximum compression
- `/caveman wenyan` — 文言文 mode (classical Chinese)
- `/caveman-help` — Reference card

## Benchmarks

Real token measurements from production:

| Task | Normal | Caveman | Saved |
|------|--------|---------|-------|
| Explain React re-render bug | 1180 | 159 | 87% |
| Fix auth middleware | 704 | 121 | 83% |
| Set up DB connection pool | 2347 | 380 | 84% |
| Explain git rebase vs merge | 702 | 292 | 58% |
| Docker multi-stage build | 1042 | 290 | 72% |
| Debug race condition | 1200 | 232 | 81% |
| Implement error boundary | 3454 | 456 | 87% |
| **Average** | **1214** | **294** | **75%** |

Source: [JuliusBrussee/caveman benchmarks](https://github.com/JuliusBrussee/caveman#benchmarks)

## See Also

- `.github/copilot-instructions.md` — Full caveman documentation
- `.agents/skills/caveman/` — Caveman skill files
- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) — Full ecosystem
