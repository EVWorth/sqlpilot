# CI

How the automated workflows are set up, and the one-time configuration they
need. For cutting a release see [RELEASING.md](RELEASING.md).

## Workflows

| Workflow                                                      | Trigger                      | What it does                                                                      |
| ------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| [`ci.yml`](../.github/workflows/ci.yml)                       | PR to `main`, push to `main` | Lint, typecheck, format, test. Jobs are gated by changed paths.                   |
| [`release.yml`](../.github/workflows/release.yml)             | `v*` tag, manual dispatch    | Validates the tag against manifests, runs the database integration tests, builds. |
| [`dprint-update.yml`](../.github/workflows/dprint-update.yml) | Mondays 09:00 UTC, manual    | Bumps dprint plugins and opens a PR if anything drifted.                          |

`ci.yml` skips work it does not need: a docs-only PR runs neither the Rust nor
the frontend suite. A PR touching any workflow file runs `Lint (workflows)`,
which is actionlint plus
[`scripts/check-action-pins.sh`](../scripts/check-action-pins.sh) — the latter
verifies every pinned action SHA is 40 hex characters and resolves upstream.
That check exists because a 41-character pin once sat in `dprint-update.yml`
and failed every scheduled run for months without anyone noticing (#534).

Run the same checks locally with `just lint-workflows`.

## Automation identity

`dprint-update.yml` opens its PR as a **GitHub App**, not as Actions. This is
one-time setup; without it the workflow fails its preflight step with a message
naming the missing secrets.

### Why not `GITHUB_TOKEN`

Two independent reasons, either one sufficient:

- **It cannot open a PR by default.** The repository setting _Settings → Actions
  → General → Workflow permissions → "Allow GitHub Actions to create and approve
  pull requests"_ gates the underlying API, so `gh pr create` and every
  PR-opening action hit it equally. That switch also grants Actions the ability
  to **approve** PRs, which becomes a review-requirement bypass the moment
  branch protection is added to `main`. Turning it on for a formatter bump buys
  a dormant permission nobody will remember.
- **PRs it opens get no CI.** GitHub suppresses workflow runs triggered by
  `GITHUB_TOKEN` to prevent recursion. The bump would arrive unchecked — the
  same shape as the defect above.

An App installation token is subject to neither. The repo setting stays off,
and the PR runs the full suite.

### Setup

Once, by someone with admin on the repository.

1. **Create the App.** <https://github.com/settings/apps> → _New GitHub App_.
   - _Name_: anything unowned, e.g. `sqlpilot-automation`. This name becomes the
     PR author, shown as `sqlpilot-automation[bot]`.
   - _Homepage URL_: the repo URL is fine.
   - **Uncheck _Active_ under Webhook.** The App never receives events.
   - _Repository permissions_: **Contents: Read and write**, **Pull requests:
     Read and write**. Nothing else — no organization or account permissions.
   - _Where can this App be installed_: only this account.
2. **Generate a private key.** On the App's page, _Private keys_ → _Generate a
   private key_. A `.pem` downloads. It is shown once.
3. **Install it.** The App's _Install App_ tab → install on this account →
   _Only select repositories_ → `sqlpilot`.
4. **Add two repository secrets.** Repo _Settings → Secrets and variables →
   Actions_:
   - `DPRINT_BOT_APP_ID` — the numeric _App ID_ from the App's General tab.
   - `DPRINT_BOT_PRIVATE_KEY` — the entire contents of the `.pem`, including the
     `-----BEGIN RSA PRIVATE KEY-----` and `-----END` lines.
5. **Delete the local `.pem`.** The secret is stored; the file on disk is now
   only a liability.
6. **Verify**: `gh workflow run dprint-update.yml --ref main`. It should either
   open a PR or report no drift and exit clean.

The App's private key does not expire, unlike a personal access token. Rotate it
from the App's _Private keys_ tab if it is ever exposed — generate the new key,
update the secret, then delete the old key.

### If the App is ever removed

The workflow fails at its preflight step with the missing secret named. It does
not silently fall back to `GITHUB_TOKEN`, because that fallback would push a
branch and then fail anyway, or open an unchecked PR if the repo setting had
been turned on in the meantime.
