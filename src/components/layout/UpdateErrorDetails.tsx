import { Bug, Copy, ExternalLink, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";

/**
 * The "Update failed" chip and the panel it opens.
 *
 * Lifted out of StatusBar, where it was ninety lines of inline JSX plus its own
 * state, ref, click-outside effect, diagnostic assembly and two handlers — nine
 * concerns in a strip that is meant to show indicators (#451). None of it is
 * shared with the rest of the bar, so none of it needed to be there.
 */

export interface UpdateErrorDetailsProps {
  /** App version, for the diagnostic. Absent until the lookup resolves. */
  appVersion: string | null;
  /** How this build was installed, for the diagnostic. */
  packageFormat: string | null;
}

/** Where "Report issue" files to. */
const ISSUES_URL = "https://github.com/EVWorth/sqlpilot/issues/new";

export function UpdateErrorDetails({ appVersion, packageFormat }: UpdateErrorDetailsProps) {
  const updateStatus = useSettingsStore((s) => s.updateStatus);
  const updateVersion = useSettingsStore((s) => s.updateVersion);
  const updateError = useSettingsStore((s) => s.updateError);
  const checkForUpdates = useSettingsStore((s) => s.checkForUpdates);

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Returning null below does not unmount this — React keeps the instance and
  // its state while the element stays in the same position — so the panel
  // would come back open on the next failure. StatusBar used to own this
  // reset; it belongs with the state it resets.
  useEffect(() => {
    if (updateStatus !== "error") setOpen(false);
  }, [updateStatus]);

  // Nothing to show unless an update actually failed.
  if (updateStatus !== "error") return null;

  // Built on render rather than memoised: it carries a timestamp, and one
  // frozen at mount would report when the app started rather than when the
  // user copied it.
  const diagnostic = [
    `SQLPilot v${appVersion || "unknown"}`,
    `Platform: ${navigator.platform} (${navigator.userAgent})`,
    `Install type: ${packageFormat ?? "unknown"}`,
    `Update status: ${updateStatus}${updateVersion ? ` (target v${updateVersion})` : ""}`,
    updateError ? `Error: ${updateError}` : null,
    `Timestamp: ${new Date().toISOString()}`,
  ].filter(Boolean).join("\n");

  const handleCopy = () => {
    void navigator.clipboard.writeText(diagnostic).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleReportIssue = () => {
    const body = [
      "## What happened",
      "<!-- Describe what you were doing when the update failed. -->",
      "",
      "## Diagnostic",
      "```",
      diagnostic,
      "```",
    ].join("\n");
    const url = `${ISSUES_URL}`
      + `?title=${encodeURIComponent("Auto-update failed: <one-line summary>")}`
      + `&labels=${encodeURIComponent("bug,auto-update")}`
      + `&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="relative flex items-center gap-1" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-yellow-400 hover:text-yellow-300 transition-colors"
        title={updateError
          ? `Update failed: ${updateError} — click for details`
          : "Update check failed — click for details"}
      >
        <RefreshCw className="h-3 w-3" />
        Update failed
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Update error details"
          className="absolute bottom-full right-0 mb-2 w-[420px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-3 shadow-lg text-left"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-primary)]">
              <Bug className="h-3.5 w-3.5 text-red-400" />
              Update failed
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              title="Close"
              aria-label="Close update error details"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {updateError && (
            <pre className="max-h-32 overflow-auto rounded bg-[var(--color-bg-secondary)] p-2 text-[10px] font-mono whitespace-pre-wrap break-words text-red-400 mb-2">
              {updateError}
            </pre>
          )}
          <pre className="max-h-32 overflow-auto rounded bg-[var(--color-bg-secondary)] p-2 text-[10px] font-mono whitespace-pre-wrap text-[var(--color-text-muted)] mb-3">
            {diagnostic}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]"
            >
              <Copy className="h-3 w-3" />
              {copied ? "Copied" : "Copy diagnostic"}
            </button>
            <button
              onClick={handleReportIssue}
              className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]"
            >
              <ExternalLink className="h-3 w-3" />
              Report issue
            </button>
            <button
              onClick={() => {
                setOpen(false);
                void checkForUpdates(true);
              }}
              className="flex items-center gap-1 rounded bg-yellow-500/20 px-2 py-1 text-[10px] text-yellow-400 hover:bg-yellow-500/30"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
