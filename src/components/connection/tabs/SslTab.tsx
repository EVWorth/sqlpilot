import type { ConnectionProfileInput, SSLConfig } from "../../../types";
import { Field } from "../../common/Field";

const sslModes: { value: SSLConfig["mode"]; label: string; description: string }[] = [
  { value: "Disabled", label: "Disabled", description: "No SSL encryption" },
  { value: "Preferred", label: "Preferred", description: "Use SSL if available, fall back to unencrypted" },
  { value: "Required", label: "Required", description: "Always use SSL, fail if unavailable" },
  { value: "VerifyCA", label: "Verify CA", description: "Require SSL and verify the server certificate" },
  { value: "VerifyIdentity", label: "Verify Identity", description: "Verify CA and server hostname" },
];

interface SslTabProps {
  form: ConnectionProfileInput;
  onChange: (updates: Partial<SSLConfig>) => void;
}

/** How much the connection insists on being encrypted, and what it trusts. */
export function SslTab({ form, onChange: handleSSLChange }: SslTabProps) {
  const sslMode = form.ssl_config?.mode ?? "Disabled";

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          SSL Mode
        </label>
        <select
          value={sslMode}
          onChange={(e) => handleSSLChange({ mode: e.target.value as SSLConfig["mode"] })}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-brand-500"
        >
          {sslModes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
          {sslModes.find((m) => m.value === sslMode)?.description}
        </p>
      </div>

      {sslMode !== "Disabled" && (
        <div className="space-y-3">
          <Field
            label="CA Certificate"
            value={form.ssl_config?.ca_cert_path || ""}
            onChange={(v) => handleSSLChange({ ca_cert_path: v || undefined })}
            placeholder="/path/to/ca.pem"
          />
          <Field
            label="Client Certificate"
            value={form.ssl_config?.client_cert_path || ""}
            onChange={(v) => handleSSLChange({ client_cert_path: v || undefined })}
            placeholder="/path/to/client-cert.pem"
          />
          <Field
            label="Client Key"
            value={form.ssl_config?.client_key_path || ""}
            onChange={(v) => handleSSLChange({ client_key_path: v || undefined })}
            placeholder="/path/to/client-key.pem"
          />
          {(sslMode === "VerifyCA" || sslMode === "VerifyIdentity")
            && !form.ssl_config?.ca_cert_path && (
            <p className="text-[10px] text-yellow-400">
              ⚠ CA certificate is required for {sslMode === "VerifyCA" ? "Verify CA" : "Verify Identity"} mode
            </p>
          )}
        </div>
      )}
    </div>
  );
}
