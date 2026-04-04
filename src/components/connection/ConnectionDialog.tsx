import { useState } from "react";
import { X, Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { ConnectionProfile, TestConnectionResult } from "../../types";
import { api } from "../../lib/tauri-api";
import { useConnectionStore } from "../../stores/connectionStore";

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

export function ConnectionDialog({ isOpen, onClose, editProfile }: Props) {
  const [form, setForm] = useState(
    editProfile ??
      ({
        ...defaultProfile,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as ConnectionProfile),
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
    value: string | number | boolean,
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testConnection(form);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: String(e), latency_ms: 0 });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveProfile(form);
      onClose();
    } catch (e) {
      console.error("Save failed:", e);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[500px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
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

        {/* Form */}
        <div className="space-y-3 p-4">
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

          {/* Test Result */}
          {testResult && (
            <div
              className={`flex items-center gap-2 rounded p-2 text-xs ${testResult.success ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}
            >
              {testResult.success ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              <span>{testResult.message}</span>
              {testResult.latency_ms > 0 && (
                <span className="ml-auto text-[var(--color-text-muted)]">
                  {testResult.latency_ms}ms
                </span>
              )}
            </div>
          )}
        </div>

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
