import type { PackageFormat } from "./bindings";

/**
 * Whether this install may replace its own files, and what to tell the user
 * when it may not.
 *
 * A packaged app does not own its own binary. Flatpak and Snap manage
 * revisions themselves, and an OSTree host mounts /usr read-only and applies
 * layered packages on the next boot. In all three the updater cannot do its
 * job, and offering it produces a failure the user cannot act on.
 *
 * The previous check asked only whether /usr/bin/rpm-ostree existed, which
 * gets the Flatpak case backwards: inside the sandbox the host's /usr is not
 * visible, so a Flatpak on Silverblue looked like an ordinary install and was
 * offered an auto-update its runtime cannot apply (#354).
 */

export interface ManualUpdate {
  /** What to run, ready to copy. */
  command: string;
  /** Why the app is not doing it. */
  reason: string;
}

/** True when the app may download and apply an update itself. */
export function canSelfUpdate(format: PackageFormat): boolean {
  return format === "standard" || format === "app_image";
}

/**
 * The command that updates this install, for the formats that manage
 * themselves.
 *
 * The architecture is the running app's, not a guess: an aarch64 machine was
 * previously handed an x86_64 download URL (#571).
 */
export function manualUpdateFor(
  format: PackageFormat,
  version: string,
  arch: string,
): ManualUpdate | null {
  switch (format) {
    case "flatpak":
      return {
        command: "flatpak update dev.sqlpilot.SQLPilot",
        reason: "Flatpak manages its own updates, so SQLPilot cannot replace its own files.",
      };
    case "snap":
      return {
        command: "sudo snap refresh sqlpilot",
        reason: "snapd manages the installed revision, so SQLPilot cannot update itself.",
      };
    case "rpm_ostree":
      return {
        command:
          `rpm-ostree install https://github.com/EVWorth/sqlpilot/releases/download/v${version}/SQLPilot-${version}-1.${arch}.rpm`,
        reason: "This is an OSTree system: /usr is read-only and layered packages apply on the next boot.",
      };
    default:
      return null;
  }
}
