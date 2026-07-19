# Security Architecture

## Content Security Policy (CSP)

SQLPilot uses a layered security model with Tauri's built-in protections and a configured Content Security Policy.

### Current Policy

```
default-src 'self';
script-src 'self' 'unsafe-eval' blob:;
style-src 'self' 'unsafe-inline';
worker-src 'self' blob:;
connect-src ipc: http://ipc.localhost http://localhost:* http://127.0.0.1:*
```

### CSP Directive Rationale

| Directive     | Value                | Reason                                                              |
| ------------- | -------------------- | ------------------------------------------------------------------- |
| `default-src` | `'self'`             | Baseline: all resources must come from the application package      |
| `script-src`  | `'self'`             | Loaded scripts must be bundled with the app                         |
| `script-src`  | `'unsafe-eval'`      | Required by Monaco Editor's WebWorker and dynamic module loading    |
| `script-src`  | `blob:`              | Needed for Monaco worker bootstrapping in the embedded webview      |
| `style-src`   | `'self'`             | Bundled stylesheets (Tailwind build)                                |
| `style-src`   | `'unsafe-inline'`    | Inline styles for dynamic layout values (width/height calculations) |
| `worker-src`  | `'self' blob:`       | WebWorkers (Monaco Editor parsing, syntax highlighting)             |
| `connect-src` | `ipc:`               | Tauri IPC command channel                                           |
| `connect-src` | `http://localhost:*` | Development: Vite dev server (removed in production builds)         |
| `connect-src` | `http://127.0.0.1:*` | Development: Local testing servers                                  |

### Accepted Trade-offs

1. **unsafe-eval**: Monaco Editor is fundamental to the app's functionality. Modern versions (~0.55+) have reduced eval dependencies, but WebWorkers and dynamic module loading still require this directive.

2. **unsafe-inline for styles**: Inline styles are still used for dynamic layout values. Removing this would require:
   - Pre-computing all possible dynamic values (impractical)
   - Or using CSS custom properties + external stylesheets (significant refactor)
   - Or generating style nonces at runtime (complex Tauri integration)

### Future Improvements

1. **Evaluate Monaco pinning**: Monitor Monaco Editor releases for improved CSP compatibility. Versions ≥0.60 may reduce eval dependencies.

2. **Tailwind extraction**: Consider pre-extracting frequently-used dynamic values to reduce reliance on runtime style injection.

3. **Nonce-based inline scripts**: If inline script injection becomes necessary (currently not), implement script-time nonce generation in Tauri:
   ```rust
   // In Tauri command handler
   let nonce = generate_secure_nonce();
   // Pass nonce to frontend, use in <script nonce="...">
   ```

### Threat Model

This CSP protects against:

- ✅ XSS attacks injecting external scripts (default-src 'self')
- ✅ Remote resource loading (images, fonts, stylesheets from untrusted CDNs)
- ⚠️ Inline XSS (partially mitigated by Tauri's native context + origin verification)

Assumes:

- ✅ App dependencies are from trusted sources (npm packages are vetted)
- ✅ Tauri's IPC origin check prevents injected script communication
- ✅ No untrusted user content is evaluated (no `eval(user_input)`)

### Related Security Layers

See [ARCHITECTURE.md](./design/ARCHITECTURE.md) Section 6.2 "Tauri Security Model" for:

- Command allowlist restrictions
- IPC origin validation
- Permission scopes enforcement
- Absence of remote content loading

### Release Signing

The release workflow conditionally signs Windows artifacts when the required secrets are available:

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

The workflow injects the Windows certificate thumbprint into the build config at runtime so the repository does not need to store machine-specific signing metadata. macOS builds are produced but not signed or notarized.
## validation test edit
## path-filter validation test
