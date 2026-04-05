import { useState } from "react";
import {
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Shield,
  Terminal,
  Settings,
  Database,
} from "lucide-react";
import type {
  ConnectionProfile,
  ConnectionEnvironment,
  SSLConfig,
  SSHConfig,
  TestConnectionResult,
} from "../../types";
import { api } from "../../lib/tauri-api";
import { useConnectionStore } from "../../stores/connectionStore";

const PRESET_COLORS = [
  "#3B82F6",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F97316",
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  editProfile?: ConnectionProfile;
}

const defaultProfile: Omit<
  ConnectionProfile,
  "id" | "created_at" | "updated_at"
> = {
  name: "",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "",
  default_database: "",
  pool_min: 1,
  pool_max: 5,
  read_only: false,
};

type TabId = "general" | "ssl" | "ssh" | "advanced";

const tabs: { id: TabId; label: string; icon: typeof Database }[] = [
  { id: "general", label: "General", icon: Database },
  { id: "ssl", label: "SSL", icon: Shield },
  { id: "ssh", label: "SSH Tunnel", icon: Terminal },
  { id: "advanced", label: "Advanced", icon: Settings },
];

const sslModes: { value: SSLConfig["mode"]; label: string; description: string }[] = [
  { value: "Disabled", label: "Disabled", description: "No SSL encryption" },
  { value: "Preferred", label: "Preferred", description: "Use SSL if available, fall back to unencrypted" },
  { value: "Required", label: "Required", description: "Always use SSL, fail if unavailable" },
  { value: "VerifyCA", label: "Verify CA", description: "Require SSL and verify the server certificate" },
  { value: "VerifyIdentity", label: "Verify Identity", description: "Verify CA and server hostname" },
];

export function ConnectionDialog({ isOpen, onClose, editProfile }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [form, setForm] = useState(
    editProfile ??
      ({
        ...defaultProfile,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as ConnectionProfile),
  );
  const [sshEnabled, setSshEnabled] = useState(!!editProfile?.ssh_config);
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key">(
    editProfile?.ssh_config?.private_key_path ? "key" : "password",
  );
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(
    null,
  );
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveProfile = useConnectionStore((s) => s.saveProfile);

  if (!isOpen) return null;

  const handleChange = (
    field: keyof ConnectionProfile,
    value: string | number | boolean | undefined,
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  const handleSSLChange = (updates: Partial<SSLConfig>) => {
    setForm((prev) => ({
      ...prev,
      ssl_config: {
        mode: "Disabled" as const,
        ...prev.ssl_config,
        ...updates,
      },
    }));
    setTestResult(null);
  };

  const handleSSHChange = (updates: Partial<SSHConfig>) => {
    setForm((prev) => ({
      ...prev,
      ssh_config: {
        host: "",
        port: 22,
        username: "",
        ...prev.ssh_config,
        ...updates,
      },
    }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const profile = buildProfileForSave();
    try {
      const result = await api.testConnection(profile);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: String(e), latency_ms: 0 });
    }
    setTesting(false);
  };

  const buildProfileForSave = (): ConnectionProfile => {
    const profile = { ...form };
    // Clear SSH config if disabled
    if (!sshEnabled) {
      profile.ssh_config = undefined;
    } else if (profile.ssh_config) {
      // Clear irrelevant auth fields based on method
      if (sshAuthMethod === "password") {
        profile.ssh_config = {
          ...profile.ssh_config,
          private_key_path: undefined,
          passphrase: undefined,
        };
      } else {
        profile.ssh_config = {
          ...profile.ssh_config,
          password: undefined,
        };
      }
    }
    // Clear SSL file paths if mode is Disabled
    if (!profile.ssl_config || profile.ssl_config.mode === "Disabled") {
      profile.ssl_config = undefined;
    }
    return profile;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveProfile(buildProfileForSave());
      onClose();
    } catch (e) {
      console.error("Save failed:", e);
    }
    setSaving(false);
  };

  const sslMode = form.ssl_config?.mode ?? "Disabled";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[560px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <h2 className="text-sm font-semibold">
            {editProfile ? "Edit Connection" : "New Connection"}
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--color-border)]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-brand-500 text-brand-400"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="min-h-[320px] p-4">
          {/* General Tab */}
          {activeTab === "general" && (
            <div className="space-y-3">
              <Field
                label="Name"
                value={form.name}
                onChange={(v) => handleChange("name", v)}
                placeholder="My Database"
              />
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Field
                    label="Host"
                    value={form.host}
                    onChange={(v) => handleChange("host", v)}
                  />
                </div>
                <Field
                  label="Port"
                  value={String(form.port)}
                  onChange={(v) => handleChange("port", parseInt(v) || 3306)}
                  type="number"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Username"
                  value={form.username}
                  onChange={(v) => handleChange("username", v)}
                />
                <Field
                  label="Password"
                  value={form.password}
                  onChange={(v) => handleChange("password", v)}
                  type="password"
                />
              </div>
              <Field
                label="Default Database"
                value={form.default_database || ""}
                onChange={(v) => handleChange("default_database", v)}
                placeholder="(optional)"
              />
              {/* Color picker */}
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Color
                </label>
                <div className="flex items-center gap-1.5">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => handleChange("color", c)}
                      className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                        form.color === c
                          ? "border-[var(--color-text-primary)] scale-110"
                          : "border-transparent"
                      }`}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                  {form.color && (
                    <button
                      type="button"
                      onClick={() => handleChange("color", "")}
                      className="ml-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              {/* Environment */}
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Environment
                </label>
                <select
                  value={form.environment ?? ""}
                  onChange={(e) =>
                    handleChange(
                      "environment",
                      e.target.value || undefined,
                    )
                  }
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-brand-500"
                >
                  <option value="">None</option>
                  <option value="development">Development</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production</option>
                </select>
              </div>
            </div>
          )}

          {/* SSL Tab */}
          {activeTab === "ssl" && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  SSL Mode
                </label>
                <select
                  value={sslMode}
                  onChange={(e) =>
                    handleSSLChange({ mode: e.target.value as SSLConfig["mode"] })
                  }
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
                  {(sslMode === "VerifyCA" || sslMode === "VerifyIdentity") &&
                    !form.ssl_config?.ca_cert_path && (
                      <p className="text-[10px] text-yellow-400">
                        ⚠ CA certificate is required for {sslMode === "VerifyCA" ? "Verify CA" : "Verify Identity"} mode
                      </p>
                    )}
                </div>
              )}
            </div>
          )}

          {/* SSH Tunnel Tab */}
          {activeTab === "ssh" && (
            <div className="space-y-4">
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
                      onChange={(v) =>
                        handleSSHChange({ port: parseInt(v) || 22 })
                      }
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

                  {sshAuthMethod === "password" ? (
                    <Field
                      label="SSH Password"
                      value={form.ssh_config?.password || ""}
                      onChange={(v) => handleSSHChange({ password: v || undefined })}
                      type="password"
                    />
                  ) : (
                    <div className="space-y-3">
                      <Field
                        label="Private Key File"
                        value={form.ssh_config?.private_key_path || ""}
                        onChange={(v) =>
                          handleSSHChange({ private_key_path: v || undefined })
                        }
                        placeholder="~/.ssh/id_rsa"
                      />
                      <Field
                        label="Passphrase"
                        value={form.ssh_config?.passphrase || ""}
                        onChange={(v) =>
                          handleSSHChange({ passphrase: v || undefined })
                        }
                        type="password"
                        placeholder="(optional)"
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Advanced Tab */}
          {activeTab === "advanced" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Pool Min Connections"
                  value={String(form.pool_min)}
                  onChange={(v) => handleChange("pool_min", parseInt(v) || 1)}
                  type="number"
                />
                <Field
                  label="Pool Max Connections"
                  value={String(form.pool_max)}
                  onChange={(v) => handleChange("pool_max", parseInt(v) || 5)}
                  type="number"
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.read_only}
                  onChange={(e) => handleChange("read_only", e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[var(--color-border)] accent-brand-500"
                />
                <span className="text-xs font-medium text-[var(--color-text-primary)]">
                  Read-only mode
                </span>
              </label>
              <div className="mt-4 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-4 text-center">
                <p className="text-xs text-[var(--color-text-muted)]">
                  More settings coming soon
                </p>
                <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  Connection timeout, query timeout, character set
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Test Result */}
        {testResult && (
          <div className="px-4 pb-2">
            <div
              className={`flex items-center gap-2 rounded p-2 text-xs ${testResult.success ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}
            >
              {testResult.success ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate">{testResult.message}</span>
              {testResult.latency_ms > 0 && (
                <span className="ml-auto shrink-0 text-[var(--color-text-muted)]">
                  {testResult.latency_ms}ms
                </span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-[var(--color-border)] p-4">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 rounded bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
          >
            {testing && <Loader2 className="h-3 w-3 animate-spin" />}
            Test Connection
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.name || !form.host}
              className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-brand-500"
      />
    </div>
  );
}
