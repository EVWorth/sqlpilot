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
import { serverFlavour } from "../../lib/server-flavour";
import { useAppInfoStore } from "../../stores/appInfoStore";
import { useConnectionHealthStore } from "../../stores/connectionHealthStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useEditorStore } from "../../stores/editorStore";
import { useResultStore } from "../../stores/resultStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { type StorageErrorKey, useStorageErrorStore } from "../../stores/storageErrorStore";
import { EnvironmentBadge } from "../connection/EnvironmentBadge";
import { ConnectionErrorChip } from "./ConnectionErrorChip";
import { UpdateErrorDetails } from "./UpdateErrorDetails";

/**
 * "MySQL 8.0.36" or "MariaDB 10.11.6": the vendor from the version string.
 * It always said MySQL, so a MariaDB server read "MySQL 10.11.6-MariaDB" (#838).
 */
export function serverLabel(version: string): string {
  if (serverFlavour(version) === "mariadb") {
    return `MariaDB ${version.replace(/-MariaDB.*$/i, "")}`;
  }
  return `MySQL ${version}`;
}

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
  // A failed connect is shown in full under the tab bar, with Retry and Edit;
  // repeating it here would only be the cut-off copy (#804).
  const connectionError = useConnectionStore((s) => s.failedProfileId ? null : s.error);
  // Undefined until the check answers; only `false` shows the warning, so a
  // slow reply never flashes it at someone whose keyring is fine.
  const keyringAvailable = useAppInfoStore((s) => s.keyringAvailable);

  useEffect(() => {
    void useAppInfoStore.getState().checkKeyring();
  }, []);
  const storageErrors = useStorageErrorStore((s) => s.errors);
  const dismissStorageError = useStorageErrorStore((s) => s.dismissStorageError);
  const clearConnectionError = useConnectionStore((s) => s.clearError);
  const isExecuting = useResultStore((s) => s.isExecuting);
  const results = useResultStore((s) => s.results);
  const activeResultIndex = useResultStore((s) => s.activeResultIndex);
  const error = useResultStore((s) => s.error);
  const cancelledAfterMs = useResultStore((s) => s.cancelledAfterMs);
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
  const appVersion = useAppInfoStore((s) => s.appVersion);
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
    void useAppInfoStore.getState().loadAppVersion();
  }, []);

  // What the backend could not do before the window existed — no saved
  // connections, no history, a data folder that will not persist. These used
  // to be panics, which meant the process vanished and the user saw nothing
  // at all.
  const startupProblems = useAppInfoStore((s) => s.startupProblems);
  const [dismissedProblems, setDismissedProblems] = useState<string[]>([]);
  useEffect(() => {
    void useAppInfoStore.getState().loadStartupProblems();
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
  const connecting = useConnectionStore((s) => s.connecting);
  const connectingNames = connecting.map((id) => {
    const profile = profiles.find((p) => p.id === id);
    return profile?.name || profile?.host || id;
  });
  const activeProfile = activeConn
    ? profiles.find((p) => p.id === activeConn.profile_id)
    : undefined;
  // What the backend's health checker last said about this connection.
  const health = useConnectionHealthStore((s) => selectedConnectionId ? s.health[selectedConnectionId] : undefined);

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
                // `group`, or the copy icon's group-hover never fires (#838).
                className="group flex items-center gap-1.5 hover:text-[var(--color-text-primary)] transition-colors"
                title="Click to copy connection string"
              >
                <span
                  data-testid="connection-health-dot"
                  aria-label={health && !health.healthy ? "Connection lost" : "Connection healthy"}
                  className={`h-1.5 w-1.5 rounded-full ${
                    health && !health.healthy ? "animate-pulse bg-[var(--color-error)]" : "bg-[var(--color-success)]"
                  }`}
                />
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {/* The profile's name, which an edit changes; the server the session is really on (#831). */}
                  {activeProfile?.name || activeConn.name} — {activeConn.host}:{activeConn.port}
                </span>
                {copied
                  ? <Check className="h-2.5 w-2.5 text-[var(--color-success)]" />
                  : (
                    <Copy className="h-2.5 w-2.5 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                  )}
              </button>
              <EnvironmentBadge environment={activeProfile?.environment} />
              {selectedDatabase && (
                <span className="text-xs text-brand-400 font-medium">
                  {selectedDatabase}
                </span>
              )}
              <span className="text-xs text-[var(--color-text-muted)]">
                {serverLabel(activeConn.server_version)}
              </span>
              {health && !health.healthy && (
                <span
                  data-testid="connection-lost"
                  title={health.error ?? undefined}
                  className="flex items-center gap-1 rounded surface-error px-1.5 py-0.5 text-xs font-medium text-[var(--color-error)]"
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Lost — retrying ({health.consecutiveFailures})
                </span>
              )}
              {keyringAvailable === false && (
                <span
                  title="No OS credential store was available at startup, so connection passwords are kept only for this session."
                  className="flex items-center gap-1 rounded surface-warning px-1.5 py-0.5 text-xs font-medium text-[var(--color-warning)]"
                >
                  <KeyRound className="h-2.5 w-2.5" />
                  Passwords not saved
                </span>
              )}
            </>
          )
          : connectingNames.length > 0
          ? (
            // The first connect used to leave this on "Disconnected" for the
            // whole wait (#799).
            <span className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
              <Loader2 className="h-3 w-3 animate-spin" />
              Connecting to {connectingNames.join(", ")}…
            </span>
          )
          : (
            <span className="text-xs text-[var(--color-text-muted)]">
              Disconnected
            </span>
          )}
      </div>
      <div className="flex items-center gap-3">
        {connectionError && (
          <ConnectionErrorChip key={connectionError} message={connectionError} onDismiss={clearConnectionError} />
        )}
        {startupProblems
          .filter((p) => !dismissedProblems.includes(p.kind))
          .map((problem) => (
            <button
              key={problem.kind}
              data-testid={`startup-problem-${problem.kind}`}
              onClick={() => setDismissedProblems((d) => [...d, problem.kind])}
              title={`${problem.detail}\n\nClick to dismiss.`}
              className="flex max-w-[380px] items-center gap-1 rounded surface-warning px-1.5 py-0.5 text-xs font-medium text-[var(--color-warning)] hover:surface-warning-strong"
            >
              <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{problem.summary}</span>
            </button>
          ))}

        {storageErrorEntries.map(([key, message]) => (
          <button
            key={key}
            onClick={() => dismissStorageError(key as StorageErrorKey)}
            className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-warning)] max-w-[300px] hover:text-[var(--color-warning)] transition-colors"
            title={`${message} — click to dismiss`}
          >
            <AlertTriangle className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{message}</span>
          </button>
        ))}
        {error && !isExecuting && (
          <button
            onClick={() => setShowFullError(!showFullError)}
            className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-error)] max-w-[300px] hover:text-[var(--color-error)] transition-colors"
            title={showFullError ? error : "Click to expand error"}
          >
            <AlertCircle className="h-3 w-3 flex-shrink-0" />
            <span className={showFullError ? "" : "truncate"}>
              {error}
            </span>
          </button>
        )}
        {cancelledAfterMs !== null && !error && !isExecuting && (
          // Neutral: the user stopped it on purpose (#850).
          <span className="text-xs text-[var(--color-text-muted)]">Cancelled</span>
        )}
        {warningsCount > 0 && !isExecuting && (
          <div className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-warning)]">
            <AlertTriangle className="h-3 w-3" />
            {warningsCount} warning{warningsCount !== 1 ? "s" : ""}
          </div>
        )}
        {isExecuting && (
          <div className="flex min-h-6 items-center gap-1 text-xs text-brand-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Executing...
          </div>
        )}
        {activeResult && !isExecuting && (
          <span className="text-xs text-[var(--color-text-muted)]">
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
              className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-success)] hover:text-[var(--color-success)] transition-colors"
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
                <p className="text-xs font-medium text-[var(--color-text-primary)]">
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
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Downloads in the background. SQLPilot will ask before restarting.
                </p>
                <a
                  href={releaseUrl(updateVersion ?? "")}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs text-brand-400 hover:underline"
                >
                  What's in this release
                </a>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      setShowUpdateConfirm(false);
                      void installUpdate();
                    }}
                    className="flex-1 rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700"
                  >
                    Download
                  </button>
                  <button
                    onClick={() => {
                      setShowUpdateConfirm(false);
                      dismissUpdate();
                    }}
                    className="flex-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
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
            className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-success)] hover:text-[var(--color-success)] transition-colors"
            title={`v${updateVersion} is installed — restart to finish`}
          >
            <RefreshCw className="h-3 w-3" />
            Restart to finish update
          </button>
        )}
        {updateStatus === "manual-update-required" && manualUpdateCommand && (
          <button
            onClick={handleCopyManualCommand}
            className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-warning)] hover:text-[var(--color-warning)] transition-colors"
            title={`Click to copy: ${manualUpdateCommand}\n(then run in a terminal; reboot to apply)`}
          >
            <Terminal className="h-3 w-3" />
            {copiedCommand ? "Copied command" : `Manual update on rpm-ostree (v${updateVersion})`}
          </button>
        )}
        {updateStatus === "checking" && (
          <span className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-text-muted)]">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Checking updates...
          </span>
        )}
        {updateStatus === "downloading" && (
          <span
            className="flex items-center gap-1.5 text-xs text-brand-400"
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
          className="flex min-h-6 items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          title="Check for updates"
        >
          {appVersion && `v${appVersion}`}
          {updateStatus === "up-to-date" && <Check className="h-2.5 w-2.5 text-[var(--color-success)]" />}
        </button>
      </div>
    </div>
  );
}
