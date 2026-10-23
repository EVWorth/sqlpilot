import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { actionById, MENUS, runAction } from "../../lib/actions";
import { requestConnect } from "../../lib/connect-request";
import { useConnectionStore } from "../../stores/connectionStore";

export function MenuBar() {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [connectToOpen, setConnectToOpen] = useState(false);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const openProfileIds = new Set(activeConnections.map((c) => c.profile_id));
  const connecting = useConnectionStore((s) => s.connecting);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenu === null) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openMenu]);

  const handleItemClick = useCallback((id: string) => {
    setOpenMenu(null);
    runAction(id);
  }, []);

  const handleConnect = (profileId: string) => {
    setOpenMenu(null);
    requestConnect(profileId);
  };

  return (
    <div ref={barRef} className="flex items-center">
      {MENUS.map((menu, idx) => (
        <div key={menu.label} className="relative">
          <button
            onClick={() => {
              setConnectToOpen(false);
              setOpenMenu(openMenu === idx ? null : idx);
            }}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              openMenu === idx
                ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {menu.label}
          </button>

          {openMenu === idx && (
            <div className="absolute left-0 top-full z-50 min-w-48 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg">
              {menu.entries.map((entry, i) => {
                if (entry.type === "separator") {
                  return <div key={i} className="my-1 h-px bg-[var(--color-border)]" />;
                }
                if (entry.type === "connect-to") {
                  // The saved profiles, one click from the menu bar (#817).
                  return (
                    <div
                      key={i}
                      className="relative"
                      onMouseEnter={() => setConnectToOpen(true)}
                      onMouseLeave={() => setConnectToOpen(false)}
                    >
                      <button
                        onClick={() => setConnectToOpen((v) => !v)}
                        aria-haspopup="menu"
                        aria-expanded={connectToOpen}
                        className="flex w-full items-center justify-between gap-8 px-3 py-1 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <span>Connect to</span>
                        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
                      </button>
                      {connectToOpen && (
                        <div
                          role="menu"
                          aria-label="Connect to"
                          className="absolute left-full top-0 z-50 min-w-48 max-w-72 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-lg"
                        >
                          {profiles.length === 0 && (
                            <p className="px-3 py-1 text-xs text-[var(--color-text-muted)]">No saved connections</p>
                          )}
                          {profiles.map((profile) => {
                            const isOpen = openProfileIds.has(profile.id);
                            const isOpening = connecting.includes(profile.id);
                            return (
                              <button
                                key={profile.id}
                                role="menuitem"
                                disabled={isOpen || isOpening}
                                onClick={() => handleConnect(profile.id)}
                                className="flex w-full items-center justify-between gap-4 px-3 py-1 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 disabled:hover:bg-transparent"
                              >
                                <span className="truncate">{profile.name || profile.host}</span>
                                {isOpen && <span className="shrink-0 text-[var(--color-text-muted)]">connected</span>}
                                {!isOpen && isOpening && (
                                  <span className="shrink-0 text-[var(--color-text-muted)]">connecting</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }
                const action = actionById(entry.id);
                if (!action) return null;
                return (
                  <button
                    key={entry.id}
                    onClick={() => handleItemClick(entry.id)}
                    className="flex w-full items-center justify-between gap-8 px-3 py-1 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                  >
                    <span>{action.label}</span>
                    {action.shortcut && (
                      <span className="shrink-0 text-[var(--color-text-muted)]">{action.shortcut}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
