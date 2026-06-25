import { Code, Eye, EyeOff, Loader2, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/tauri-api";
import { escapeIdentifier } from "./userPrivileges";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  onCreated: () => void;
}

const HOST_OPTIONS = ["%", "localhost", "127.0.0.1"] as const;
const AUTH_PLUGINS = ["caching_sha2_password", "mysql_native_password"] as const;

export function CreateUserDialog({
  isOpen,
  onClose,
  connectionId,
  onCreated,
}: Props) {
  const [username, setUsername] = useState("");
  const [host, setHost] = useState("%");
  const [customHost, setCustomHost] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authPlugin, setAuthPlugin] = useState<string>("caching_sha2_password");
  const [maxConnections, setMaxConnections] = useState("");
  const [accountLocked, setAccountLocked] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const effectiveHost = host === "__custom__" ? customHost : host;

  function buildSql(): string {
    const parts = [
      `CREATE USER ${escapeIdentifier(username)}@${escapeIdentifier(effectiveHost)}`,
      `IDENTIFIED WITH ${authPlugin} BY ${escapeIdentifier(password)}`,
    ];
    const maxConn = parseInt(maxConnections, 10);
    if (!isNaN(maxConn) && maxConn > 0) {
      parts.push(`WITH MAX_USER_CONNECTIONS ${maxConn}`);
    }
    if (accountLocked) {
      parts.push("ACCOUNT LOCK");
    }
    return parts.join("\n  ") + ";";
  }

  const isValid = username.trim() !== ""
    && effectiveHost.trim() !== ""
    && password !== ""
    && password === confirmPassword;

  const handleCreate = async () => {
    if (!isValid) return;
    setCreating(true);
    setError(null);
    try {
      await api.executeQuery(connectionId, buildSql());
      onCreated();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[480px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Create User
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 p-4">
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}

          {/* Username */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Username <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. app_user"
              className="h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
            />
          </div>

          {/* Host */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Host
            </label>
            <div className="flex gap-2">
              <select
                value={HOST_OPTIONS.includes(host as typeof HOST_OPTIONS[number]) ? host : "__custom__"}
                onChange={(e) => setHost(e.target.value)}
                className="h-8 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none"
              >
                {HOST_OPTIONS.map((h) => (
                  <option key={h} value={h}>
                    {h === "%" ? "% (any host)" : h}
                  </option>
                ))}
                <option value="__custom__">Custom…</option>
              </select>
              {host === "__custom__" && (
                <input
                  type="text"
                  value={customHost}
                  onChange={(e) => setCustomHost(e.target.value)}
                  placeholder="hostname or IP"
                  className="h-8 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
                />
              )}
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Password <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 pr-8 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Confirm Password */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Confirm Password <span className="text-red-400">*</span>
            </label>
            <input
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={`h-8 w-full rounded border bg-[var(--color-bg-primary)] px-2.5 text-xs text-[var(--color-text-primary)] focus:outline-none ${
                confirmPassword && confirmPassword !== password
                  ? "border-red-500 focus:border-red-500"
                  : "border-[var(--color-border)] focus:border-brand-500"
              }`}
            />
            {confirmPassword && confirmPassword !== password && (
              <p className="mt-1 text-[10px] text-red-400">
                Passwords do not match
              </p>
            )}
          </div>

          {/* Auth Plugin */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Authentication Plugin
            </label>
            <select
              value={authPlugin}
              onChange={(e) => setAuthPlugin(e.target.value)}
              className="h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--color-text-primary)] focus:border-brand-500 focus:outline-none"
            >
              {AUTH_PLUGINS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* Max Connections */}
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Max Connections <span className="text-[var(--color-text-muted)]">(0 = unlimited)</span>
            </label>
            <input
              type="number"
              min={0}
              value={maxConnections}
              onChange={(e) => setMaxConnections(e.target.value)}
              placeholder="Unlimited"
              className="h-8 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-brand-500 focus:outline-none"
            />
          </div>

          {/* Account Locked */}
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={accountLocked}
              onChange={(e) => setAccountLocked(e.target.checked)}
              className="rounded border-[var(--color-border)]"
            />
            Account Locked
          </label>

          {/* SQL Preview */}
          {showPreview && username && (
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2">
              <pre className="whitespace-pre-wrap text-[11px] font-mono text-[var(--color-text-secondary)]">
                {buildSql()}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--color-border)] p-4">
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <Code className="h-3.5 w-3.5" />
            {showPreview ? "Hide" : "Preview"} SQL
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!isValid || creating}
              className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create User
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
