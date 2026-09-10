import { Activity, GitBranch, List, Server, Shield, Users } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { ProcessListTab } from "./ProcessListTab";
import { ReplicationTab } from "./ReplicationTab";
import { RolesTab } from "./RolesTab";
import { ServerStatusTab } from "./ServerStatusTab";
import { ServerVariablesTab } from "./ServerVariablesTab";
import { UserManagement } from "./UserManagement";

type AdminSubTab = "processes" | "variables" | "status" | "users" | "roles" | "replication";

/**
 * The admin tab bar and content area, and nothing else.
 *
 * This file was 793 lines: the shell plus three tabs that had nothing to do
 * with each other, sharing only the file they were in (#432). Each tab is its
 * own file now, and the status arithmetic — the part worth testing — is a
 * module rather than a function buried among them.
 *
 * No admin store, deliberately (#442). Only the active tab renders, so there
 * is one poller at a time and nothing to share; a store per tab would be
 * indirection with a single consumer each. If something outside this panel
 * ever needs the process list, that is the point to add one.
 */
interface AdminPanelProps {
  connectionId: string;
}

export function AdminPanel({ connectionId }: AdminPanelProps) {
  const [activeSubTab, setActiveSubTab] = useState<AdminSubTab>("processes");

  const subTabs: { key: AdminSubTab; label: string; icon: typeof Activity }[] = [
    { key: "processes", label: "Process List", icon: List },
    { key: "variables", label: "Server Variables", icon: Server },
    { key: "status", label: "Server Status", icon: Activity },
    { key: "users", label: "Users", icon: Users },
    { key: "roles", label: "Roles", icon: Shield },
    { key: "replication", label: "Replication", icon: GitBranch },
  ];

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)]">
      <div className="flex h-8 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1">
        {subTabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveSubTab(key)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
              activeSubTab === key
                ? "bg-[var(--color-bg-primary)] text-brand-400"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {activeSubTab === "processes" && <ProcessListTab connectionId={connectionId} />}
        {activeSubTab === "variables" && <ServerVariablesTab connectionId={connectionId} />}
        {activeSubTab === "status" && <ServerStatusTab connectionId={connectionId} />}
        {activeSubTab === "users" && <UserManagement connectionId={connectionId} />}
        {activeSubTab === "roles" && <RolesTab connectionId={connectionId} />}
        {activeSubTab === "replication" && <ReplicationTab connectionId={connectionId} />}
      </div>
    </div>
  );
}
