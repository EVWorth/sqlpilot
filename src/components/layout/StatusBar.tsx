import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { releaseUrl } from "../../lib/repo";
import { api } from "../../lib/tauri-api";
import { useConnectionHealthStore } from "../../stores/connectionHealthStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { type StorageErrorKey, useStorageErrorStore } from "../../stores/storageErrorStore";
import type { ConnectionEnvironment } from "../../types";
import { UpdateErrorDetails } from "./UpdateErrorDetails";

const ENV_BADGES: Record<ConnectionEnvironment, { label: string; className: string }> = {
  production: { label: "PROD", className: "bg-red-500/20 text-red-400" },
  staging: { label: "STG", className: "bg-yellow-500/20 text-yellow-400" },
  development: { label: "DEV", className: "bg-green-500/20 text-green-400" },
};

function formatTime(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRows(count: number): string {
  return count.toLocaleString() + " row" + (count === 1 ? "" : "s");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function StatusBar() {
  const activeConnections = useConnectionStore((s) => s.activeConnections);
  const selectedConnectionId = useConnectionStore(
    (s) => s.selectedConnectionId,
  );
  const connectionError = useConnectionStore((s) => s.error);
  // Undefined until the check answers; only `false` shows the warning, so a
  // slow reply never flashes it at someone whose keyring is fine.
  const [keyringAvailable, setKeyringAvailable] = useState<boolean | undefined>();

  useEffect(() => {
    api.keyringAvailable().then(setKeyringAvailable).catch(() => {
      // The check itself failing says nothing about the keyring; stay quiet.
    });
  }, []);
  const storageErrors = useStorageErrorStore((s) => s.errors);
  const dismissStorageError = useStorageErrorStore((s) => s.dismissStorageError);
  const clearConnectionError = useConnectionStore((s) => s.clearError);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const results = useResultStore((s) => s.results);
  const activeResultIndex = useResultStore((s) => s.activeResultIndex);
  const error = useResultStore((s) => s.error);
  // Derived in the selector, not from the whole array. Reading `tabs` meant a
  // new array identity on every keystroke-debounced content write re-rendered
  // this 400-line component and reflowed its update overlay, for a value that
  // had not changed (#458). A string compares by value, so the render only
  // happens when the active tab's database actually differs.
  const activeTabDatabase = useEditorStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.database,
  );

  const storageErrorEntries = Object.entries(storageErrors);

  const [showFullError, setShowFullError] = useState(false);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const updateStatus = useSettingsStore((s) => s.updateStatus);
  const updateVersion = useSettingsStore((s) => s.updateVersion);
  const manualUpdateCommand = useSettingsStore((s) => s.manualUpdateCommand);
  const packageFormat = useSettingsStore((s) => s.packageFormat);
  const downloadProgress = useSettingsStore((s) => s.downloadProgress);
  const checkForUpdates = useSettingsStore((s) => s.checkForUpdates);
  const installUpdate = useSettingsStore((s) => s.installUpdate);
  const restartToApply = useSettingsStore((s) => s.restartToApply);
  const dismissUpdate = useSettingsStore((s) => s.dismissUpdate);
  const dismissedVersion = useSettingsStore((s) => s.dismissedVersion);
  const updateConfirmRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.getAppVersion().then(setAppVersion).catch((e) => console.error("Failed to get app version", e));
  }, []);

  useEffect(() => {
    void useSettingsStore.getState().detectPlatform();
  }, []);

  // Automatic, so no force: the store throttles these and skips one while an
  // install is in flight (#346, #347).
  useEffect(() => {
    if (updateStatus === "idle") void checkForUpdates();
  }, [checkForUpdates, updateStatus]);

  useEffect(() => {
    if (!showUpdateConfirm) return;
    const onDocClick = (e: MouseEvent) => {
      if (updateConfirmRef.current && !updateConfirmRef.current.contains(e.target as Node)) {
        setShowUpdateConfirm(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showUpdateConfirm]);

  const activeConn = activeConnections.find(
    (c) => c.id === selectedConnectionId,
  );
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfile = activeConn
    ? profiles.find((p) => p.id === activeConn.profile_id)
    : undefined;
  const envBadge = activeProfile?.environment
    ? ENV_BADGES[activeProfile.environment]
    : undefined;
  // What the backend's health checker last said about this connection, and
  // how much of its pool is in use.
  const health = useConnectionHealthStore((s) => selectedConnectionId ? s.health[selectedConnectionId] : undefined);
  const pool = useConnectionHealthStore((s) => selectedConnectionId ? s.pools[selectedConnectionId] : undefined);

  const activeResult = results[activeResultIndex];
  const selectedDatabase = activeTabDatabase ?? activeConn?.database;
  const warningsCount = activeResult?.warnings?.length ?? 0;

  const handleCopyConnection = () => {
    if (!activeConn) return;
    const connStr = `mysql://${activeConn.host}:${activeConn.port}${
      activeConn.database ? "/" + activeConn.database : ""
    }`;
    navigator.clipboard.writeText(connStr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleCopyManualCommand = () => {
    if (!manualUpdateCommand) return;
    void navigator.clipboard.writeText(manualUpdateCommand).then(() => {
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 2000);
    });
  };

  return (
    <div className="flex h-6 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3">
      <div className="flex items-center gap-3">
        {activeConn
          ? (
            <>
              <button
                onClick={handleCopyConnection}
                className="flex items-center gap-1.5 hover:text-[var(--color-text-primary)] transition-colors"
                title="Click to copy connection string"
              >
                <span
                  data-testid="connection-health-dot"
                  aria-label={health && !health.healthy ? "Connection lost" : "Connection healthy"}
                  className={`h-1.5 w-1.5 rounded-full ${
                    health && !health.healthy ? "animate-pulse bg-red-500" : "bg-green-400"
                  }`}
                />
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  {activeConn.name} — {activeConn.host}:{activeConn.port}
                </span>
                {copied
                  ? <Check className="h-2.5 w-2.5 text-green-400" />
                  : <Copy className="h-2.5 w-2.5 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100" />}
              </button>
              {envBadge && (
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${envBadge.className}`}>
                  {envBadge.label}
                </span>
              )}
              {selectedDatabase && (
                <span className="text-[10px] text-brand-400 font-medium">
                  {selectedDatabase}
                </span>
              )}
              <span className="text-[10px] text-[var(--color-text-muted)]">
                MySQL {activeConn.server_version}
              </span>
              {health && !health.healthy && (
                <span
                  data-testid="connection-lost"
                  title={health.error ?? undefined}
                  className="flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-400"
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Lost — retrying ({health.consecutiveFailures})
                </span>
              )}
              {pool && (
                <span
                  data-testid="pool-stats"
                  title={`${pool.size - pool.idle} of ${pool.max} connections in use, ${pool.idle} idle. `
                    + "A query waits when they are all busy."}
                  className={`text-[10px] ${
                    pool.size - pool.idle >= pool.max
                      ? "text-amber-400"
                      : "text-[var(--color-text-muted)]"
                  }`}
                >
                  pool {pool.size - pool.idle}/{pool.max}
                </span>
              )}
              {keyringAvailable === false && (
                <span
                  title="No OS credential store was available at startup, so connection passwords are kept only for this session."
                  className="flex items-center gap-1 rounded bg-yellow-500/15 px-1.5 py-0.5 text-[9px] font-medium text-yellow-400"
                >
                  <KeyRound className="h-2.5 w-2.5" />
                  Passwords not saved
                </span>
              )}
            </>
          )
          : (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              Disconnected
            </span>
          )}
      </div>
      <div className="flex items-center gap-3">
        {connectionError && (
          <button
            onClick={clearConnectionError}
            className="flex items-center gap-1 text-[10px] text-red-400 max-w-[300px] hover:text-red-300 transition-colors"
            title="Connection error — click to dismiss"
          >
            <AlertCircle className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{connectionError}</span>
          </button>
        )}
        {storageErrorEntries.map(([key, message]) => (
          <button
            key={key}
            onClick={() => dismissStorageError(key as StorageErrorKey)}
            className="flex items-center gap-1 text-[10px] text-yellow-400 max-w-[300px] hover:text-yellow-300 transition-colors"
            title={`${message} — click to dismiss`}
          >
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{message}</span>
          </button>
        ))}
        {error && !isExecuting && (
          <button
            onClick={() => setShowFullError(!showFullError)}
            className="flex items-center gap-1 text-[10px] text-red-400 max-w-[300px] hover:text-red-300 transition-colors"
            title={showFullError ? error : "Click to expand error"}
          >
            <AlertCircle className="h-3 w-3 flex-shrink-0" />
            <span className={showFullError ? "" : "truncate"}>
              {error}
            </span>
          </button>
        )}
        {warningsCount > 0 && !isExecuting && (
          <div className="flex items-center gap-1 text-[10px] text-yellow-400">
            <AlertTriangle className="h-3 w-3" />
            {warningsCount} warning{warningsCount !== 1 ? "s" : ""}
          </div>
        )}
        {isExecuting && (
          <div className="flex items-center gap-1 text-[10px] text-brand-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Executing...
          </div>
        )}
        {activeResult && !isExecuting && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {formatRows(activeResult.rows.length)} · {formatTime(activeResult.execution_time_ms)}
          </span>
        )}
        {updateStatus === "available" && updateVersion !== dismissedVersion && (
          <div className="relative" ref={updateConfirmRef}>
            <button
              onClick={() =>
                setShowUpdateConfirm((open) =>
                  !open
                )}
              className="flex items-center gap-1 text-[10px] text-green-400 hover:text-green-300 transition-colors"
              title={`Update v${updateVersion} available`}
            >
              <Download className="h-3 w-3" />
              Update to v{updateVersion}
            </button>
            {showUpdateConfirm && (
              <div
                data-testid="update-confirm"
                className="absolute bottom-full right-0 mb-2 w-64 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 shadow-lg"
              >
                <p className="text-[11px] font-medium text-[var(--color-text-primary)]">
                  Update to v{updateVersion}
                </p>
                {
                  /*
                  No size: the download's length is not known until it starts,
                  and inventing an estimate would be worse than omitting one.
                  No restart claim either — since #573 the restart is a
                  separate step the user takes when ready.
                */
                }
                <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  Downloads in the background. SQLPilot will ask before restarting.
                </p>
                <a
                  href={releaseUrl(updateVersion ?? "")}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-[10px] text-brand-400 hover:underline"
                >
                  What's in this release
                </a>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      setShowUpdateConfirm(false);
                      void installUpdate();
                    }}
                    className="flex-1 rounded bg-brand-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-brand-500"
                  >
                    Download
                  </button>
                  <button
                    onClick={() => {
                      setShowUpdateConfirm(false);
                      dismissUpdate();
                    }}
                    className="flex-1 rounded px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                  >
                    Later
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {updateStatus === "downloaded" && (
          <button
            /* Downloading and restarting are separate: the app closing is the
               part that can lose work, so it waits to be asked (#344). */
            onClick={() => void restartToApply()}
            className="flex items-center gap-1 text-[10px] text-green-400 hover:text-green-300 transition-colors"
            title={`v${updateVersion} is installed — restart to finish`}
          >
            <RefreshCw className="h-3 w-3" />
            Restart to finish update
          </button>
        )}
        {updateStatus === "manual-update-required" && manualUpdateCommand && (
          <button
            onClick={handleCopyManualCommand}
            className="flex items-center gap-1 text-[10px] text-yellow-400 hover:text-yellow-300 transition-colors"
            title={`Click to copy: ${manualUpdateCommand}\n(then run in a terminal; reboot to apply)`}
          >
            <Terminal className="h-3 w-3" />
            {copiedCommand ? "Copied command" : `Manual update on rpm-ostree (v${updateVersion})`}
          </button>
        )}
        {updateStatus === "checking" && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Checking updates...
          </span>
        )}
        {updateStatus === "downloading" && (
          <span
            className="flex items-center gap-1.5 text-[10px] text-brand-400"
            title={`Downloading update... ${
              downloadProgress.total
                ? `${formatBytes(downloadProgress.transferred)} / ${formatBytes(downloadProgress.total)}`
                : formatBytes(downloadProgress.transferred)
            }`}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Downloading update
            {downloadProgress.total
              ? (
                <span className="tabular-nums">
                  {Math.min(
                    100,
                    Math.round((downloadProgress.transferred / downloadProgress.total) * 100),
                  )}
                  %
                </span>
              )
              : downloadProgress.transferred > 0
              ? <span className="tabular-nums">{formatBytes(downloadProgress.transferred)}</span>
              : null}
          </span>
        )}
        <UpdateErrorDetails appVersion={appVersion} packageFormat={packageFormat} />
        <button
          onClick={() => void checkForUpdates(true)}
          className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Check for updates"
        >
          {appVersion && `v${appVersion}`}
          {updateStatus === "up-to-date" && <Check className="h-2.5 w-2.5 text-green-400" />}
        </button>
      </div>
    </div>
  );
}
