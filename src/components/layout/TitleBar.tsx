import { getCurrentWindow } from "@tauri-apps/api/window";
import { clsx } from "clsx";
import {
  Activity,
  ArrowLeftRight,
  HardDriveDownload,
  HardDriveUpload,
  LayoutGrid,
  Minus,
  Monitor,
  Moon,
  Sparkles,
  Square,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { type ThemeMode, useThemeStore } from "../../stores/themeStore";
import { MenuBar } from "./MenuBar";

const appWindow = getCurrentWindow();

const themeOrder: ThemeMode[] = ["dark", "light", "system"];
const themeIcons: Record<ThemeMode, typeof Sun> = { dark: Moon, light: Sun, system: Monitor };
const themeLabels: Record<ThemeMode, string> = { dark: "Dark", light: "Light", system: "System" };

// Restore icon: two overlapping squares
function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2" y="0" width="8" height="8" rx="0.5" />
      <rect x="0" y="2" width="8" height="8" rx="0.5" fill="var(--color-bg-secondary)" />
      <rect x="0" y="2" width="8" height="8" rx="0.5" />
    </svg>
  );
}

interface TitleBarProps {
  onShowImport?: () => void;
  onShowBackup?: () => void;
  onShowRestore?: () => void;
  onToggleAI?: () => void;
  aiPanelOpen?: boolean;
  aiEnabled?: boolean;
}

export function TitleBar(
  { onShowImport, onShowBackup, onShowRestore, onToggleAI, aiPanelOpen, aiEnabled }: TitleBarProps,
) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [systemMenu, setSystemMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastClickTime = useRef(0);

  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId);
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const ThemeIcon = themeIcons[theme];

  const handleOpenAdmin = () => {
    if (!selectedConnectionId) return;
    useEditorStore.getState().addAdminTab(selectedConnectionId);
  };
  const handleOpenCompare = () => useEditorStore.getState().addCompareTab();
  const handleOpenQueryBuilder = () => {
    if (!selectedConnectionId) return;
    const conn = activeConnections.find((c) => c.id === selectedConnectionId);
    if (conn?.database) useEditorStore.getState().addQueryBuilderTab(selectedConnectionId, conn.database);
  };
  const cycleTheme = () => {
    const idx = themeOrder.indexOf(theme);
    setTheme(themeOrder[(idx + 1) % themeOrder.length]);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setIsMaximized);
    appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!systemMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setSystemMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSystemMenu(null);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [systemMenu]);

  function startDrag(e: React.MouseEvent) {
    if (e.button === 0) appWindow.startDragging();
  }

  function handleSpacerMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const now = Date.now();
    if (now - lastClickTime.current < 400) {
      lastClickTime.current = 0;
      appWindow.toggleMaximize();
    } else {
      lastClickTime.current = now;
      appWindow.startDragging();
    }
  }

  function showSystemMenu(e: React.MouseEvent) {
    e.preventDefault();
    setSystemMenu({ x: e.clientX, y: e.clientY });
  }

  function runSystemAction(action: (() => void) | null) {
    setSystemMenu(null);
    action?.();
  }

  const sysMenuItems = [
    { id: "restore", label: "Restore", disabled: !isMaximized, action: () => appWindow.unmaximize() },
    { id: "move", label: "Move", disabled: true, action: null },
    { id: "size", label: "Size", disabled: true, action: null },
    { id: "minimize", label: "Minimize", disabled: false, action: () => appWindow.minimize() },
    { id: "maximize", label: "Maximize", disabled: isMaximized, action: () => appWindow.maximize() },
    null,
    { id: "close", label: "Close", shortcut: "Alt+F4", disabled: false, action: () => appWindow.close() },
  ] as const;

  const winBtn =
    "flex h-full w-11 items-center justify-center text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] transition-colors";
  const toolBtn = (disabled = false) =>
    clsx(
      "flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors",
      disabled
        ? "text-[var(--color-text-muted)] opacity-40 cursor-not-allowed"
        : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]",
    );

  return (
    <div
      className="relative flex h-9 shrink-0 select-none items-center bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]"
      onContextMenu={showSystemMenu}
    >
      {/* Icon — drag handle */}
      <div onMouseDown={startDrag} className="flex items-center px-3 cursor-default">
        <img src="/icon.svg" alt="SQLPilot" className="h-6 w-6 pointer-events-none" />
      </div>

      {/* Inline menu */}
      <MenuBar />

      {/* Spacer — draggable; double-click toggles maximize */}
      <div onMouseDown={handleSpacerMouseDown} className="flex-1 h-full cursor-default" />

      {/* Toolbar buttons */}
      <div className="flex items-center gap-0.5 px-1" onContextMenu={(e) => e.stopPropagation()}>
        <button
          onClick={handleOpenQueryBuilder}
          disabled={!selectedConnectionId}
          title="Visual Query Builder"
          className={toolBtn(!selectedConnectionId)}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          <span>Visual Builder</span>
        </button>
        <button onClick={handleOpenCompare} title="Compare Schemas" className={toolBtn()}>
          <ArrowLeftRight className="h-3.5 w-3.5" />
          <span>Compare</span>
        </button>
        <button
          onClick={handleOpenAdmin}
          disabled={!selectedConnectionId}
          title="Admin Tools"
          className={toolBtn(!selectedConnectionId)}
        >
          <Activity className="h-3.5 w-3.5" />
          <span>Admin</span>
        </button>
        <button
          onClick={onShowImport}
          disabled={!selectedConnectionId}
          title="Import Data"
          className={toolBtn(!selectedConnectionId)}
        >
          <Upload className="h-3.5 w-3.5" />
          <span>Import</span>
        </button>
        <button
          onClick={onShowBackup}
          disabled={!selectedConnectionId}
          title="Backup Database"
          className={toolBtn(!selectedConnectionId)}
        >
          <HardDriveDownload className="h-3.5 w-3.5" />
          <span>Backup</span>
        </button>
        <button
          onClick={onShowRestore}
          disabled={!selectedConnectionId}
          title="Restore Database"
          className={toolBtn(!selectedConnectionId)}
        >
          <HardDriveUpload className="h-3.5 w-3.5" />
          <span>Restore</span>
        </button>
        {aiEnabled && (
          <button
            onClick={onToggleAI}
            title="Toggle AI Assistant"
            className={clsx(
              "flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors",
              aiPanelOpen
                ? "bg-brand-600/20 text-brand-400"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]",
            )}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>AI</span>
          </button>
        )}
        <button onClick={cycleTheme} title={`Theme: ${themeLabels[theme]} (click to cycle)`} className={toolBtn()}>
          <ThemeIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-[var(--color-border)] mx-1" onContextMenu={(e) => e.stopPropagation()} />

      {/* Window controls */}
      <div className="flex h-full" onContextMenu={(e) => e.stopPropagation()}>
        <button onClick={() => appWindow.minimize()} className={winBtn} title="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          className={winBtn}
          title={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <RestoreIcon /> : <Square className="h-3 w-3" />}
        </button>
        <button
          onClick={() => appWindow.close()}
          className="flex h-full w-11 items-center justify-center text-[var(--color-text-muted)] hover:bg-red-600 hover:text-white transition-colors"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* System context menu */}
      {systemMenu && (
        <div
          ref={menuRef}
          style={{ position: "fixed", left: systemMenu.x, top: systemMenu.y }}
          className="z-[9999] min-w-[180px] rounded-sm border border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-1 shadow-xl text-sm"
        >
          {sysMenuItems.map((item, i) =>
            item === null ? <div key={i} className="my-1 border-t border-[var(--color-border)]" /> : (
              <button
                key={item.id}
                disabled={item.disabled}
                onClick={() => runSystemAction(item.action ?? null)}
                className={clsx(
                  "flex w-full items-center justify-between px-4 py-[3px] text-left",
                  item.disabled
                    ? "text-[var(--color-text-muted)] opacity-50 cursor-default"
                    : "text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] cursor-default",
                )}
              >
                <span>{item.label}</span>
                {"shortcut" in item && item.shortcut && (
                  <span className="ml-8 text-[var(--color-text-muted)]">{item.shortcut}</span>
                )}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
