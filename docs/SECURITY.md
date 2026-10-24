# Security Architecture

Read before touching the CSP, Tauri capabilities, credential storage or the
agent endpoint. The wider picture (credential flow, network, destructive
operation safeguards) is in [ARCHITECTURE.md](./design/ARCHITECTURE.md)
section 6.

## Content Security Policy (CSP)

SQLPilot uses Tauri's built-in protections plus a Content Security Policy set
in `app.security` of [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json):
`csp` for release builds and `devCsp` for `just dev`.

### Current Policy

Release builds (`csp`):

```
default-src 'self';
script-src 'self' 'unsafe-eval' blob:;
style-src 'self' 'unsafe-inline';
worker-src 'self' blob:;
connect-src ipc: http://ipc.localhost
```

Development (`devCsp`) is the same plus
`connect-src http://localhost:* http://127.0.0.1:*`, for the Vite dev server.
Keep the two in step: a directive added to one usually belongs in both.

### CSP Directive Rationale

| Directive     | Value                       | Reason                                                              |
| ------------- | --------------------------- | ------------------------------------------------------------------- |
| `default-src` | `'self'`                    | Baseline: all resources must come from the application package      |
| `script-src`  | `'self'`                    | Loaded scripts must be bundled with the app                         |
| `script-src`  | `'unsafe-eval'`             | Required by Monaco Editor's worker and dynamic module loading       |
| `script-src`  | `blob:`                     | Needed for Monaco worker bootstrapping in the embedded webview      |
| `style-src`   | `'self'`                    | Bundled stylesheets (Tailwind build)                                |
| `style-src`   | `'unsafe-inline'`           | Inline styles for dynamic layout values (width/height calculations) |
| `worker-src`  | `'self' blob:`              | Monaco's `editor.worker`, set up in `src/main.tsx`                  |
| `connect-src` | `ipc: http://ipc.localhost` | Tauri IPC command channel                                           |
| `connect-src` | `http://localhost:*`        | Dev only: the Vite dev server (`devUrl` is `http://localhost:1420`) |
| `connect-src` | `http://127.0.0.1:*`        | Dev only: local servers during development                          |

Release builds allow no loopback `connect-src`. The frontend makes no requests
to loopback; the agent endpoint is reached by the harness, not by the webview.

### Accepted Trade-offs

1. **`unsafe-eval`**: Monaco Editor is fundamental to the app. Its worker and
   dynamic module loading still require this directive. Don't try to "fix" it.
2. **`unsafe-inline` for styles**: inline styles are used for dynamic layout
   values. Removing it would need every dynamic value pre-computed, moved to
   CSS custom properties, or nonce-injected at runtime.

### Threat Model

This CSP protects against:

- XSS injecting external scripts (`default-src 'self'`)
- Remote resource loading (images, fonts, stylesheets from untrusted CDNs)
- Inline XSS only partially: `unsafe-inline` styles and `unsafe-eval` remain

It assumes:

- App dependencies come from trusted sources (npm and crates.io, with
  `npm audit`, `npm audit signatures` and `cargo audit` in CI)
- Only the commands registered in `src-tauri/src/lib.rs` are callable, and
  the window's plugin permissions are limited by
  [`src-tauri/capabilities/`](../src-tauri/capabilities/)
- No untrusted user content is evaluated (no `eval(user_input)`)

## Credentials

Connection passwords and SSH secrets are stored in the OS credential store via
`keyring-core` (Windows Credential Manager, macOS Keychain, the Linux Secret
Service, with kernel keyutils as an in-memory fallback), never in SQLite, and never sent back to the frontend. Details:
[ARCHITECTURE.md](./design/ARCHITECTURE.md) section 6.1.

## Agent Endpoint

The MCP endpoint ([`mas-mcp/src/endpoint.rs`](../src-tauri/crates/mas-mcp/src/endpoint.rs))
listens on `127.0.0.1` only, behind a bearer token kept in a 0600 file in the
data directory and rotatable from Tools → Agents…. Requests carrying an
`Origin` header are refused: no harness sends one, and it is what a
DNS-rebinding web page would need. Nothing is exposed to an agent until the
user shares a connection, columns whose names indicate credentials return no
values at any posture, and every agent write or schema change is approved in
SQLPilot's own window. Design: [AI_INTEGRATION.md](./design/AI_INTEGRATION.md).

## Release Signing

- **Updater artifacts** are signed during `tauri build` with
  `TAURI_SIGNING_PRIVATE_KEY`, because `bundle.createUpdaterArtifacts` is on.
  See [RELEASING.md](RELEASING.md).
- **Windows** artifacts are code-signed only when `WINDOWS_CERTIFICATE` and
  `WINDOWS_CERTIFICATE_PASSWORD` are set. The workflow imports the
  certificate and writes its thumbprint into the build config at runtime, so
  the repository stores no machine-specific signing metadata. Without the
  secrets it skips signing.
- **macOS** builds are produced but not signed or notarized.
