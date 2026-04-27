import { useState, useRef, useEffect } from "react";
import { Plus, X, Database, Plug, Pencil, Trash2 } from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { cn } from "../../lib/utils";
import { useContextMenu } from "../../hooks/useContextMenu";
import type { ConnectionProfile } from "../../types";

export function ConnectionTabs() {
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const connect = useConnectionStore((s) => s.connect);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const deleteProfile = useConnectionStore((s) => s.deleteProfile);
  const setSelectedConnection = useConnectionStore((s) => s.setSelectedConnection);
  const loadProfiles = useConnectionStore((s) => s.loadProfiles);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [showDialog, setShowDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | undefined>();
  const popoverRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const { contextMenu, showContextMenu } = useContextMenu();

  const openEdit = (profile: ConnectionProfile) => {
    setPopoverOpen(false);
    setEditingProfile(profile);
    setShowDialog(true);
  };

  const openNew = () => {
    setPopoverOpen(false);
    setEditingProfile(undefined);
    setShowDialog(true);
  };

  useEffect(() => {
    const init = async () => {
      await loadProfiles();

      // Auto-reconnect profiles that were active in the previous session
      const { tabs, setTabConnection: setTabConn } = useEditorStore.getState();
      const profileIds = [...new Set(
        tabs.filter((t) => t.profileId).map((t) => t.profileId!)
      )];

      for (const profileId of profileIds) {
        try {
          const conn = await connect(profileId);
          // Update all tabs belonging to this profile with the new runtime connection ID
          useEditorStore.getState().tabs
            .filter((t) => t.profileId === profileId)
            .forEach((t) => setTabConn(t.id, conn.id, t.database, profileId));
          // Select this connection if the active tab belongs to it
          const { activeTabId } = useEditorStore.getState();
          const activeTab = useEditorStore.getState().tabs.find((t) => t.id === activeTabId);
          if (activeTab?.profileId === profileId) {
            setSelectedConnection(conn.id);
          }
        } catch {
          // Server may be unreachable — leave tab without a live connection
        }
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for "open-new-connection" from menu bar
  useEffect(() => {
    const handler = () => openNew();
    window.addEventListener("open-new-connection", handler);
    return () => window.removeEventListener("open-new-connection", handler);
  }, []);

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        addButtonRef.current &&
        !addButtonRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoverOpen]);

  const togglePopover = () => {
    if (!popoverOpen && addButtonRef.current) {
      const rect = addButtonRef.current.getBoundingClientRect();
      setPopoverPos({ top: rect.bottom + 4, left: rect.left });
    }
    setPopoverOpen((v) => !v);
  };

  const activeProfileIds = new Set(activeConnections.map((c) => c.profile_id));
  const inactiveProfiles = profiles.filter((p) => !activeProfileIds.has(p.id));

  const handleConnectProfile = async (profileId: string) => {
    setPopoverOpen(false);
    try {
      const conn = await connect(profileId);
      setSelectedConnection(conn.id);
      // Propagate the connection's auto-selected database to the active editor tab
      const { activeTabId, setTabConnection } = useEditorStore.getState();
      if (activeTabId) {
        setTabConnection(activeTabId, conn.id, conn.database, conn.profile_id);
      }
    } catch {
      // Error is captured in connectionStore.error and shown in StatusBar
    }
  };

  return (
    <div className="flex h-9 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1">
      {/* Scrollable tabs area */}
      <div className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto">
        {activeConnections.map((conn) => {
          const profile = profiles.find((p) => p.id === conn.profile_id);
          const isSelected = conn.id === selectedConnectionId;
          const label = profile?.name || profile?.host || conn.id;

          return (
            <div
              key={conn.id}
              className={cn(
                "group relative flex h-7 min-w-0 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs select-none",
                isSelected
                  ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]",
              )}
              onClick={() => setSelectedConnection(conn.id)}
              onContextMenu={(e) => {
                showContextMenu(e, [
                  {
                    label: "Edit Connection",
                    icon: <Pencil className="h-3.5 w-3.5" />,
                    onClick: () => { if (profile) openEdit(profile); },
                    disabled: !profile,
                  },
                  {
                    label: "Disconnect",
                    icon: <X className="h-3.5 w-3.5" />,
                    onClick: () => disconnect(conn.id),
                  },
                  { label: "", separator: true, onClick: () => {} },
                  {
                    label: "Delete Profile",
                    icon: <Trash2 className="h-3.5 w-3.5" />,
                    onClick: () => {
                      disconnect(conn.id);
                      if (profile) deleteProfile(profile.id);
                    },
                    danger: true,
                  },
                ]);
              }}
          >
            {/* Active indicator bar */}
            {isSelected && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-brand-500" />
            )}

            <Database
              className={cn(
                "h-3 w-3 shrink-0",
                "text-green-400",
              )}
            />

            {profile?.color && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: profile.color }}
              />
            )}

            <span className="truncate">{label}</span>

            <button
              className={cn(
                "ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100",
                isSelected && "opacity-60",
                "hover:bg-[var(--color-bg-secondary)] hover:opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation();
                disconnect(conn.id);
              }}
              title="Disconnect"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}
      </div>{/* end scrollable tabs */}

      {/* Add / connect button — outside overflow container so popover isn't clipped */}
      <div className="relative ml-1 shrink-0">
        <button
          ref={addButtonRef}
          onClick={togglePopover}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          title="Connect to a server"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {popoverOpen && (
          <div
            ref={popoverRef}
            style={{ position: "fixed", top: popoverPos.top, left: popoverPos.left }}
            className="z-50 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg"
          >
            {inactiveProfiles.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                  Saved Connections
                </div>
                {inactiveProfiles.map((profile) => (
                  <div key={profile.id} className="group flex items-center hover:bg-[var(--color-bg-tertiary)]">
                    <button
                      onClick={() => handleConnectProfile(profile.id)}
                      className="flex flex-1 min-w-0 items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                    >
                      <Plug className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                      {profile.color && (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: profile.color }}
                        />
                      )}
                      <span className="truncate">{profile.name || profile.host}</span>
                    </button>
                    <button
                      onClick={() => openEdit(profile)}
                      className="mr-1 shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--color-text-primary)]"
                      title="Edit connection"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <div className="my-1 border-t border-[var(--color-border)]" />
              </>
            )}
            <button
              onClick={openNew}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            >
              <Plus className="h-3 w-3 shrink-0" />
              <span>New Connection…</span>
            </button>
          </div>
        )}
      </div>

      <ConnectionDialog isOpen={showDialog} editProfile={editingProfile} onClose={() => { setShowDialog(false); setEditingProfile(undefined); }} />
      {contextMenu}
    </div>
  );
}
