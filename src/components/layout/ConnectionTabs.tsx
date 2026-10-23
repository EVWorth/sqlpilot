import { Copy, Database, FileText, Loader2, Lock, Pencil, Plug, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useContextMenu } from "../../hooks/useContextMenu";
import { CONNECT_PROFILE_EVENT, NEW_CONNECTION_EVENT } from "../../lib/connect-request";
import { cn } from "../../lib/utils";
import { useConnectionHealthStore } from "../../stores/connectionHealthStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useSqliteStore } from "../../stores/sqliteStore";
import type { ConnectionProfileSummary } from "../../types";
import type { MenuItem } from "../common/ContextMenu";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { ConnectFailure } from "./ConnectFailure";
import { useConnectionSwitching } from "./useConnectionSwitching";
import { useProfileDeletion } from "./useProfileDeletion";

export function ConnectionTabs() {
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const sqliteSessions = useSqliteStore((s) => s.sessions);
  const sqliteOpening = useSqliteStore((s) => s.opening);
  const openSqliteFile = useSqliteStore((s) => s.openFile);
  const closeSqlite = useSqliteStore((s) => s.close);
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const connect = useConnectionStore((s) => s.connect);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const setSelectedConnection = useConnectionStore((s) => s.setSelectedConnection);
  const loadProfiles = useConnectionStore((s) => s.loadProfiles);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [showDialog, setShowDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ConnectionProfileSummary | undefined>();
  const [duplicatingProfile, setDuplicatingProfile] = useState<
    ConnectionProfileSummary | undefined
  >();
  const health = useConnectionHealthStore((s) => s.health);
  const connecting = useConnectionStore((s) => s.connecting);
  const cancelConnect = useConnectionStore((s) => s.cancelConnect);
  const connectError = useConnectionStore((s) => s.error);
  const failedProfileId = useConnectionStore((s) => s.failedProfileId);
  const clearError = useConnectionStore((s) => s.clearError);

  /**
   * What to show on a connected tab's icon. FR-1.3.2's third state,
   * "Connecting", belongs to the placeholder tab of the profile being opened,
   * not to every tab that already works (#799).
   */
  const connectionState = (connectionId: string) => {
    if (health[connectionId] && !health[connectionId].healthy) return "Disconnected";
    return "Connected";
  };
  const popoverRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const { contextMenu, showContextMenu } = useContextMenu();
  const { requestDelete, confirmDialog } = useProfileDeletion();
  const { selectConnection, attachNewConnection, attachSqliteSession } = useConnectionSwitching();

  /** Edit, duplicate and delete: what a saved profile offers wherever it is listed. */
  const profileMenuItems = (profile: ConnectionProfileSummary): MenuItem[] => [
    {
      label: "Edit Connection",
      icon: <Pencil className="h-3.5 w-3.5" />,
      onClick: () => openEdit(profile),
    },
    {
      label: "Duplicate Profile",
      icon: <Copy className="h-3.5 w-3.5" />,
      onClick: () => openDuplicate(profile),
    },
    { separator: true },
    {
      label: "Delete Profile",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      onClick: () => {
        setPopoverOpen(false);
        requestDelete(profile);
      },
      danger: true,
    },
  ];

  const openEdit = (profile: ConnectionProfileSummary) => {
    setPopoverOpen(false);
    setDuplicatingProfile(undefined);
    setEditingProfile(profile);
    setShowDialog(true);
  };

  const openDuplicate = (profile: ConnectionProfileSummary) => {
    setPopoverOpen(false);
    setEditingProfile(undefined);
    setDuplicatingProfile(profile);
    setShowDialog(true);
  };

  const openNew = () => {
    setPopoverOpen(false);
    setEditingProfile(undefined);
    setDuplicatingProfile(undefined);
    setShowDialog(true);
  };

  useEffect(() => {
    const init = async () => {
      await loadProfiles();

      // Auto-reconnect profiles that were active in the previous session
      const { tabs, setTabConnection: setTabConn } = useEditorStore.getState();
      const profileIds = [
        ...new Set(
          tabs.filter((t) => t.profileId).map((t) => t.profileId!),
        ),
      ];

      const failed: string[] = [];
      const failedIds: string[] = [];
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
        } catch (e) {
          // Cancelled from its placeholder tab: the user knows.
          if (e instanceof Error && e.message === "Connection cancelled") continue;
          // Leaving the tab without a live connection is right; saying nothing
          // about it is not. The tab looked normal and the first query failed
          // with "Connection not found", which describes neither what happened
          // nor when (#276).
          const name = useConnectionStore.getState().profiles.find((p) => p.id === profileId)?.name
            ?? profileId;
          failed.push(name);
          failedIds.push(profileId);
          console.warn(`Could not reconnect to ${name} on startup`, e);
        }
      }

      if (failed.length > 0) {
        useConnectionStore.setState({
          // One failure can offer Retry and Edit for its profile (#804).
          failedProfileId: failedIds.length === 1 ? failedIds[0] : null,
          error: failed.length === 1
            ? `Could not reconnect to ${failed[0]}. Its tabs have no live connection — use the connect button to retry.`
            : `Could not reconnect to ${failed.length} servers (${
              failed.join(", ")
            }). Their tabs have no live connection — use the connect button to retry.`,
        });
      }
    };
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for "open-new-connection" from menu bar
  useEffect(() => {
    const handler = () => openNew();
    window.addEventListener(NEW_CONNECTION_EVENT, handler);
    return () => window.removeEventListener(NEW_CONNECTION_EVENT, handler);
  }, []);

  // A connect asked for elsewhere — the menu bar, the palette, the sidebar —
  // runs through the same flow as one from the `+` menu (#817). Through a ref,
  // so the listener always calls this render's handler.
  const connectProfileRef = useRef<(profileId: string) => Promise<void>>(async () => {});
  useEffect(() => {
    const handler = (e: Event) => {
      const profileId = (e as CustomEvent<string>).detail;
      if (typeof profileId === "string") void connectProfileRef.current(profileId);
    };
    window.addEventListener(CONNECT_PROFILE_EVENT, handler);
    return () => window.removeEventListener(CONNECT_PROFILE_EVENT, handler);
  }, []);

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current
        && !popoverRef.current.contains(e.target as Node)
        && addButtonRef.current
        && !addButtonRef.current.contains(e.target as Node)
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
  const inactiveProfiles = profiles.filter((p) => !activeProfileIds.has(p.id) && !connecting.includes(p.id));

  const handleConnectProfile = async (profileId: string) => {
    setPopoverOpen(false);
    try {
      const conn = await connect(profileId);
      setSelectedConnection(conn.id);
      // A tab already on another server keeps it; the new one gets its own
      // tab, so nothing is silently re-pointed (#788).
      attachNewConnection(conn);
    } catch {
      // Error is captured in connectionStore.error and shown in StatusBar
    }
  };

  connectProfileRef.current = handleConnectProfile;

  return (
    <div className="relative flex h-9 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1">
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
              onClick={() => selectConnection(conn.id)}
              onContextMenu={(e) => {
                showContextMenu(e, [
                  {
                    label: "Edit Connection",
                    icon: <Pencil className="h-3.5 w-3.5" />,
                    onClick: () => {
                      if (profile) openEdit(profile);
                    },
                    disabled: !profile,
                  },
                  {
                    // FR-1.1.4. A second profile against the same server —
                    // another database, a read-only user — was a matter of
                    // retyping every field (#294).
                    label: "Duplicate Profile",
                    icon: <Copy className="h-3.5 w-3.5" />,
                    onClick: () => {
                      if (profile) openDuplicate(profile);
                    },
                    disabled: !profile,
                  },
                  {
                    label: "Disconnect",
                    icon: <X className="h-3.5 w-3.5" />,
                    onClick: () => disconnect(conn.id),
                  },
                  { separator: true },
                  {
                    // Asks first, naming the profile (FR-1.1.3, #795).
                    label: "Delete Profile",
                    icon: <Trash2 className="h-3.5 w-3.5" />,
                    onClick: () => {
                      if (profile) requestDelete(profile);
                    },
                    disabled: !profile,
                    danger: true,
                  },
                ]);
              }}
            >
              {/* Active indicator bar */}
              {isSelected && <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-brand-500" />}

              {
                /* Green while the server answers, red once the health checker
                  says it does not; the third FR-1.3.2 state, connecting, is
                  the placeholder tab below. It was green whatever was true
                  (#294). */
              }
              <Database
                role="img"
                aria-label={connectionState(conn.id)}
                className={cn(
                  "h-3 w-3 shrink-0",
                  connectionState(conn.id) === "Disconnected"
                    ? "text-[var(--color-error)]"
                    : "text-[var(--color-success)]",
                )}
              />

              {profile?.color && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: profile.color }}
                />
              )}

              {
                /* Read-only is enforced in the executor, but a guard the user
                  cannot see is one they will be surprised by — the refusal
                  arrives only after they run something (#277). */
              }
              {profile?.read_only && (
                <Lock
                  role="img"
                  aria-label="Read-only connection"
                  className="h-3 w-3 shrink-0 text-[var(--color-warning)]"
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

        {
          /*
          Open SQLite files, rendered beside the server connections rather
          than in a pane of their own. A file has no host, port or profile, so
          it carries only its name and a distinct icon — but selecting one
          drives the same sidebar, editor and grid (#461).
        */
        }
        {sqliteSessions.map((session) => {
          const isSelected = session.id === selectedConnectionId;
          return (
            <div
              key={session.id}
              data-testid="sqlite-tab"
              className={cn(
                "group relative flex h-7 min-w-0 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs select-none",
                isSelected
                  ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]",
              )}
              onClick={() => selectConnection(session.id)}
              title={session.path}
            >
              {isSelected && <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-brand-500" />}
              <FileText className="h-3 w-3 shrink-0 text-sky-400" />
              <span className="truncate">{session.name}</span>
              <button
                className={cn(
                  "ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100",
                  isSelected && "opacity-60",
                  "hover:bg-[var(--color-bg-secondary)] hover:opacity-100",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeSqlite(session.id);
                }}
                title="Close database"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}

        {
          /* A tab for each connect in flight, from the moment it starts, so
            the wait shows where the connection will appear (#799). */
        }
        {connecting.map((profileId) => {
          const profile = profiles.find((p) => p.id === profileId);
          const label = profile?.name || profile?.host || profileId;
          return (
            <div
              key={`connecting-${profileId}`}
              data-testid="connecting-tab"
              className="flex h-7 min-w-0 max-w-[180px] shrink-0 items-center gap-1.5 rounded px-2 text-xs text-[var(--color-text-secondary)] select-none"
              title={`Connecting to ${label}…`}
            >
              <Loader2
                role="img"
                aria-label="Connecting"
                className="h-3 w-3 shrink-0 animate-spin text-[var(--color-warning)]"
              />
              <span className="truncate">{label}</span>
              <button
                className="ml-0.5 shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-tertiary)]"
                onClick={() => cancelConnect(profileId)}
                title={`Cancel connecting to ${label}`}
                aria-label={`Cancel connecting to ${label}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}
      </div>
      {/* end scrollable tabs */}

      <button
        onClick={() => {
          void openSqliteFile().then((session) => {
            if (session) attachSqliteSession(session.id);
          });
        }}
        disabled={sqliteOpening}
        className="ml-1 flex h-7 shrink-0 items-center gap-1 rounded px-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
        title="Open a SQLite database file"
      >
        <FileText className="h-3.5 w-3.5" />
        SQLite
      </button>

      {/* Add / connect button — outside overflow container so popover isn't clipped */}
      <div className="relative ml-1 shrink-0">
        <button
          ref={addButtonRef}
          onClick={togglePopover}
          className="flex h-7 items-center gap-1 rounded px-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          title="Connect to a server"
          aria-haspopup="menu"
          aria-expanded={popoverOpen}
        >
          <Plus className="h-3.5 w-3.5" />
          {/* A visible word, not just a 24px "+" (#817). */}
          Connect
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
                  <div
                    key={profile.id}
                    className="group flex items-center hover:bg-[var(--color-bg-tertiary)]"
                    // A profile that is not connected has no tab to right-click,
                    // so this is where it can be duplicated or deleted (#795).
                    onContextMenu={(e) => showContextMenu(e, profileMenuItems(profile))}
                  >
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

      <ConnectionDialog
        isOpen={showDialog}
        editProfile={editingProfile}
        duplicateOf={duplicatingProfile}
        onClose={() => {
          setShowDialog(false);
          setEditingProfile(undefined);
        }}
        onDelete={editingProfile
          ? () => {
            const profile = editingProfile;
            setShowDialog(false);
            setEditingProfile(undefined);
            requestDelete(profile);
          }
          : undefined}
        onDuplicate={editingProfile ? () => openDuplicate(editingProfile) : undefined}
      />
      {failedProfileId && connectError && (() => {
        const failedProfile = profiles.find((p) => p.id === failedProfileId);
        return (
          <ConnectFailure
            name={failedProfile?.name || failedProfile?.host || failedProfileId}
            message={connectError}
            onRetry={() => void handleConnectProfile(failedProfileId)}
            onEdit={failedProfile
              ? () => {
                clearError();
                openEdit(failedProfile);
              }
              : undefined}
            onDismiss={clearError}
          />
        );
      })()}
      {contextMenu}
      {confirmDialog}
    </div>
  );
}
