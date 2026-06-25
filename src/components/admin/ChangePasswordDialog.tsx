import { Eye, EyeOff, Loader2, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/tauri-api";
import { escapeIdentifier } from "./userPrivileges";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  user: string;
  host: string;
}

export function ChangePasswordDialog({
  isOpen,
  onClose,
  connectionId,
  user,
  host,
}: Props) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const isValid = password !== "" && password === confirmPassword;

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      const sql = `ALTER USER ${escapeIdentifier(user)}@${escapeIdentifier(host)} IDENTIFIED BY ${
        escapeIdentifier(password)
      }`;
      await api.executeQuery(connectionId, sql);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[400px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Change Password — {user}@{host}
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

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              New Password
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

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]">
              Confirm Password
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
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] p-4">
          <button
            onClick={onClose}
            className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Change Password
          </button>
        </div>
      </div>
    </div>
  );
}
