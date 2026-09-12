import { CheckCircle2, Database, Loader2, Settings, Shield, Terminal, X, XCircle } from "lucide-react";
import { useState } from "react";
import type { ConnectionProfile } from "../../types";
import { AdvancedTab } from "./tabs/AdvancedTab";
import { GeneralTab } from "./tabs/GeneralTab";
import { SshTab } from "./tabs/SshTab";
import { SslTab } from "./tabs/SslTab";
import { useConnectionForm } from "./useConnectionForm";

/**
 * The connection form: chrome, tab switching, and the two buttons.
 *
 * Everything the form knows is in `useConnectionForm`; each tab is its own
 * component. This file was 700 lines holding all four tabs, nine pieces of
 * state and six handlers, so adding a fifth meant reading all of it (#275) —
 * it is now one entry in `TABS` and one file.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  editProfile?: ConnectionProfile;
}

type TabId = "general" | "ssl" | "ssh" | "advanced";

const TABS: { id: TabId; label: string; icon: typeof Database }[] = [
  { id: "general", label: "General", icon: Database },
  { id: "ssl", label: "SSL", icon: Shield },
  { id: "ssh", label: "SSH Tunnel", icon: Terminal },
  { id: "advanced", label: "Advanced", icon: Settings },
];

export function ConnectionDialog({ isOpen, onClose, editProfile }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const {
    form,
    sshEnabled,
    setSshEnabled,
    sshAuthMethod,
    setSshAuthMethod,
    testResult,
    testing,
    saving,
    poolProblems,
    canSave,
    handleChange,
    handleSSLChange,
    handleSSHChange,
    handleTest,
    handleSave,
  } = useConnectionForm(isOpen, editProfile);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[560px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
          <h2 className="text-sm font-semibold">
            {editProfile ? "Edit Connection" : "New Connection"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex border-b border-[var(--color-border)]" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
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

        <div className="min-h-[320px] p-4">
          {activeTab === "general" && <GeneralTab form={form} isExisting={!!editProfile} onChange={handleChange} />}
          {activeTab === "ssl" && <SslTab form={form} onChange={handleSSLChange} />}
          {activeTab === "ssh" && (
            <SshTab
              form={form}
              enabled={sshEnabled}
              onEnabledChange={setSshEnabled}
              authMethod={sshAuthMethod}
              onAuthMethodChange={setSshAuthMethod}
              onChange={handleSSHChange}
            />
          )}
          {activeTab === "advanced" && <AdvancedTab form={form} onChange={handleChange} poolProblems={poolProblems} />}
        </div>

        {testResult && (
          <div className="px-4 pb-2">
            <div
              className={`flex items-center gap-2 rounded p-2 text-xs ${
                testResult.success ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
              }`}
            >
              {testResult.success
                ? <CheckCircle2 className="h-4 w-4 shrink-0" />
                : <XCircle className="h-4 w-4 shrink-0" />}
              <span className="truncate">{testResult.message}</span>
              {testResult.latency_ms > 0 && (
                <span className="ml-auto shrink-0 text-[var(--color-text-muted)]">
                  {testResult.latency_ms}ms
                </span>
              )}
            </div>
          </div>
        )}

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
              onClick={() => void handleSave(onClose)}
              disabled={!canSave}
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
