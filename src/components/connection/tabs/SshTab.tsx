import { AlertCircle } from "lucide-react";
import type { ConnectionProfileInput, SSHConfigInput } from "../../../types";
import { Field } from "../../common/Field";

interface SshTabProps {
  form: ConnectionProfileInput;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  authMethod: "password" | "key";
  onAuthMethodChange: (method: "password" | "key") => void;
  onChange: (updates: Partial<SSHConfigInput>) => void;
}

/**
 * Tunnel settings, which are stored and not acted on.
 *
 * Kept because the settings are real and a tunnel may be built later; the
 * notice at the top says plainly that a profile using them is refused rather
 * than quietly connected direct (#273).
 */
export function SshTab({
  form,
  enabled: sshEnabled,
  onEnabledChange: setSshEnabled,
  authMethod: sshAuthMethod,
  onAuthMethodChange: setSshAuthMethod,
  onChange: handleSSHChange,
}: SshTabProps) {
  return (
    <div className="space-y-4">
      {
        /*
              The fields below are stored but not acted on: nothing in the
              backend opens a tunnel. A profile configured here used to
              connect straight to the database host while the UI implied
              the traffic was tunnelled, so the connection is now refused
              outright rather than quietly going direct (#273).
            */
      }
      <div
        data-testid="ssh-unsupported"
        className="flex items-start gap-2 rounded border border-amber-700 bg-amber-900/20 px-3 py-2 text-xs text-amber-300"
      >
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          SSH tunnelling is not implemented yet. These settings are saved, but a profile that uses them cannot connect —
          SQLPilot will refuse rather than connect directly to the database and leave you thinking the traffic is
          tunnelled. Open a tunnel yourself and point the profile at the forwarded local port instead.
        </span>
      </div>

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={sshEnabled}
          onChange={(e) => setSshEnabled(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-[var(--color-border)] accent-brand-500"
        />
        <span className="text-xs font-medium text-[var(--color-text-primary)]">
          Enable SSH Tunnel
        </span>
      </label>

      {sshEnabled && (
        <>
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2">
            <p className="text-center text-[10px] tracking-wide text-[var(--color-text-muted)]">
              App → <span className="text-brand-400">SSH Tunnel</span> → MySQL Server
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field
                label="SSH Host"
                value={form.ssh_config?.host || ""}
                onChange={(v) => handleSSHChange({ host: v })}
                placeholder="ssh.example.com"
              />
            </div>
            <Field
              label="SSH Port"
              value={String(form.ssh_config?.port ?? 22)}
              onChange={(v) => handleSSHChange({ port: parseInt(v) || 22 })}
              type="number"
            />
          </div>

          <Field
            label="SSH Username"
            value={form.ssh_config?.username || ""}
            onChange={(v) => handleSSHChange({ username: v })}
          />

          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Authentication
            </label>
            <div className="flex gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-0.5">
              <button
                onClick={() => setSshAuthMethod("password")}
                className={`flex-1 rounded px-3 py-1 text-xs font-medium transition-colors ${
                  sshAuthMethod === "password"
                    ? "bg-brand-600 text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                Password
              </button>
              <button
                onClick={() => setSshAuthMethod("key")}
                className={`flex-1 rounded px-3 py-1 text-xs font-medium transition-colors ${
                  sshAuthMethod === "key"
                    ? "bg-brand-600 text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                Key File
              </button>
            </div>
          </div>

          {sshAuthMethod === "password"
            ? (
              <Field
                label="SSH Password"
                value={form.ssh_config?.password || ""}
                onChange={(v) => handleSSHChange({ password: v || undefined })}
                type="password"
              />
            )
            : (
              <div className="space-y-3">
                <Field
                  label="Private Key File"
                  value={form.ssh_config?.private_key_path || ""}
                  onChange={(v) => handleSSHChange({ private_key_path: v || undefined })}
                  placeholder="~/.ssh/id_rsa"
                />
                <Field
                  label="Passphrase"
                  value={form.ssh_config?.passphrase || ""}
                  onChange={(v) => handleSSHChange({ passphrase: v || undefined })}
                  type="password"
                  placeholder="(optional)"
                />
              </div>
            )}
        </>
      )}
    </div>
  );
}
