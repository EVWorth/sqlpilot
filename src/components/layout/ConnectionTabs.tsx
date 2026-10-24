import { Copy, FileText, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useContextMenu } from "../../hooks/useContextMenu";
import { CONNECT_PROFILE_EVENT, NEW_CONNECTION_EVENT } from "../../lib/connect-request";
import { connectionSettingsChanged } from "../../lib/connection-changes";
import { cn } from "../../lib/utils";
import { useConnectionHealthStore } from "../../stores/connectionHealthStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useSqliteStore } from "../../stores/sqliteStore";
import type { ConnectionProfileInput, ConnectionProfileSummary } from "../../types";
import type { MenuItem } from "../common/ContextMenu";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { ConnectFailure } from "./ConnectFailure";
import { ConnectionTab } from "./ConnectionTab";
import { ConnectPopover } from "./ConnectPopover";
import { ReconnectPrompt } from "./ReconnectPrompt";
import { useConnectionSwitching } from "./useConnectionSwitching";
import { useProfileDeletion } from "./useProfileDeletion";
import { useStartupReconnect } from "./useStartupReconnect";

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
  const staleConnections = useConnectionStore((s) => s.staleConnections);
  const markStale = useConnectionStore((s) => s.markStale);
  const reconnect = useConnectionStore((s) => s.reconnect);
  // The connection to offer a reconnect for, after its profile was edited.
  const [reconnectOffer, setReconnectOffer] = useState<string | null>(null);

  /**
   * What to show on a connected tab's icon. FR-1.3.2's third state,
   * "Connecting", belongs to the placeholder tab of the profile being opened,
   * not to every tab that already works (#799).
   */
  const connectionState = (connectionId: string) => {
    if (health[connectionId] && !health[connectionId].healthy) return "Disconnected";
    return "Connected";
  };
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const { contextMenu, showContextMenu, showContextMenuAt } = useContextMenu();
  const tablistRef = useRef<HTMLDivElement>(null);
  // A connection to focus once its tab has rendered: after connecting from
  // the keyboard, focus used to drop to <body> (#827).
  const [focusAfterConnect, setFocusAfterConnect] = useState<string | null>(null);
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

  useStartupReconnect();

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

  const closePopover = useCallback((returnFocus: boolean) => {
    setPopoverOpen(false);
    if (returnFocus) addButtonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!focusAfterConnect) return;
    const tab = tablistRef.current?.querySelector<HTMLElement>(`[data-connection-id="${focusAfterConnect}"]`);
    if (!tab) return;
    tab.focus();
    setFocusAfterConnect(null);
  }, [focusAfterConnect, activeConnections]);

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
    // The menu bar, the palette and the sidebar can all ask for a profile
    // that is opening or already open. A second `api.connect` would make a
    // second live connection, and its settle would drop the first one's
    // placeholder tab. Read the store, not this render: two requests can
    // arrive before React re-renders.
    const { connecting: inFlight, activeConnections: open } = useConnectionStore.getState();
    if (inFlight.includes(profileId)) return;
    const existing = open.find((c) => c.profile_id === profileId);
    if (existing) {
      selectConnection(existing.id);
      return;
    }
    try {
      const conn = await connect(profileId);
      setSelectedConnection(conn.id);
      // A tab already on another server keeps it; the new one gets its own
      // tab, so nothing is silently re-pointed (#788).
      attachNewConnection(conn);
      // Focus was on the menu entry that asked, which is gone now. Only when
      // nothing else has it: someone who clicked into the editor while it
      // connected should stay there.
      const focused = document.activeElement;
      if (!focused || focused === document.body) setFocusAfterConnect(conn.id);
    } catch {
      // Error is captured in connectionStore.error and shown in StatusBar
    }
  };

  connectProfileRef.current = handleConnectProfile;

  /** A profile was saved from the dialog: a live connection on old settings is said so (#831). */
  const handleSaved = (saved: ConnectionProfileInput) => {
    const before = editingProfile;
    if (!before || before.id !== saved.id) return;
    const live = useConnectionStore.getState().activeConnections.find((c) => c.profile_id === saved.id);
    if (!live || !connectionSettingsChanged(before, saved)) return;
    markStale(live.id);
    setReconnectOffer(live.id);
  };

  /** Reopen a connection with its profile's current settings, keeping its editor tabs on it. */
  const handleReconnect = async (connectionId: string) => {
    setReconnectOffer(null);
    try {
      const fresh = await reconnect(connectionId);
      const { tabs, setTabConnection } = useEditorStore.getState();
      tabs
        .filter((t) => t.connectionId === connectionId)
        .forEach((t) => setTabConnection(t.id, fresh.id, t.database, fresh.profile_id));
      setSelectedConnection(fresh.id);
      setFocusAfterConnect(fresh.id);
    } catch {
      // The store has the reason in `error`, shown under the tabs or in the status bar.
    }
  };

  /** What a connected tab's menu offers, by right-click or from the keyboard. */
  const tabMenuItems = (connectionId: string, profile: ConnectionProfileSummary | undefined): MenuItem[] => [
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
    ...(staleConnections.includes(connectionId)
      ? [{
        label: "Reconnect to Apply Changes",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        onClick: () => void handleReconnect(connectionId),
      }]
      : []),
    {
      label: "Disconnect",
      icon: <X className="h-3.5 w-3.5" />,
      onClick: () => disconnect(connectionId),
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
  ];

  // One Tab stop for the strip: the selected tab, or the first when none is.
  const tabIds = [...activeConnections.map((c) => c.id), ...sqliteSessions.map((s) => s.id)];
  const tabStopId = selectedConnectionId && tabIds.includes(selectedConnectionId) ? selectedConnectionId : tabIds[0];

  /** Left, Right, Home and End move focus along the strip; Enter or Space selects. */
  const onTablistKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = [...(tablistRef.current?.querySelectorAll<HTMLElement>("[role=\"tab\"]") ?? [])];
    const at = tabs.findIndex((t) => t === e.target);
    if (at === -1) return;
    e.preventDefault();
    const next = e.key === "Home"
      ? 0
      : e.key === "End"
      ? tabs.length - 1
      : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  };

  return (
    <div className="relative flex h-9 items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1">
      {/* Scrollable tabs area */}
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="Connections"
        onKeyDown={onTablistKeyDown}
        className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto"
      >
        {activeConnections.map((conn) => {
          const profile = profiles.find((p) => p.id === conn.profile_id);
          return (
            <ConnectionTab
              key={conn.id}
              conn={conn}
              profile={profile}
              isSelected={conn.id === selectedConnectionId}
              focusable={conn.id === tabStopId}
              state={connectionState(conn.id)}
              stale={staleConnections.includes(conn.id)}
              onSelect={() => selectConnection(conn.id)}
              onDisconnect={() => disconnect(conn.id)}
              onMenu={(x, y) => showContextMenuAt(x, y, tabMenuItems(conn.id, profile))}
            />
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
              role="tab"
              aria-selected={isSelected}
              tabIndex={session.id === tabStopId ? 0 : -1}
              data-connection-id={session.id}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectConnection(session.id);
                }
              }}
              className={cn(
                "group relative flex h-7 min-w-0 max-w-[180px] shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs select-none outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                isSelected
                  ? "bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]",
              )}
              onClick={() =>
                selectConnection(session.id)}
              title={session.path}
            >
              {isSelected && <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-brand-500" />}
              <FileText className="h-3 w-3 shrink-0 text-sky-400" />
              <span className="truncate">{session.name}</span>
              <button
                tabIndex={-1}
                className={cn(
                  "ml-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
                  isSelected && "opacity-60",
                  "hover:bg-[var(--color-bg-secondary)] hover:opacity-100",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeSqlite(session.id);
                }}
                title="Close database"
                aria-label={`Close ${session.name}`}
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
          <ConnectPopover
            position={popoverPos}
            profiles={inactiveProfiles}
            anchor={addButtonRef}
            onConnect={(profile) => void handleConnectProfile(profile.id)}
            onEdit={openEdit}
            onNew={openNew}
            onProfileContextMenu={(e, profile) => showContextMenu(e, profileMenuItems(profile))}
            onClose={closePopover}
          />
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
        onSaved={handleSaved}
      />
      {reconnectOffer && (() => {
        const conn = activeConnections.find((c) => c.id === reconnectOffer);
        if (!conn) return null;
        const profile = profiles.find((p) => p.id === conn.profile_id);
        return (
          <ReconnectPrompt
            name={profile?.name || conn.name}
            oldServer={`${conn.host}:${conn.port}`}
            onReconnect={() => void handleReconnect(conn.id)}
            onLater={() => {
              setReconnectOffer(null);
              tablistRef.current?.querySelector<HTMLElement>(`[data-connection-id="${conn.id}"]`)?.focus();
            }}
          />
        );
      })()}
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
