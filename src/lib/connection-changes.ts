import type { ConnectionProfile, ConnectionProfileInput } from "../types";

/**
 * Whether an edit changes how the profile connects, as opposed to how it is
 * shown.
 *
 * A live connection was opened with the old values and keeps them: a new
 * host, user or password only applies to the next connection. Name, colour,
 * group and environment are read from the profile wherever they appear, so
 * they need no reconnect (#831).
 *
 * The form's credentials start blank and blank means "keep the stored one",
 * so any password or passphrase typed in is a change.
 */
export function connectionSettingsChanged(before: ConnectionProfile, after: ConnectionProfileInput): boolean {
  if (before.host !== after.host) return true;
  if (before.port !== after.port) return true;
  if (before.username !== after.username) return true;
  if (after.password) return true;
  if ((before.default_database || null) !== (after.default_database || null)) return true;
  if (before.read_only !== after.read_only) return true;
  if ((before.charset || null) !== (after.charset || null)) return true;
  if (JSON.stringify(before.ssl_config ?? null) !== JSON.stringify(after.ssl_config ?? null)) return true;

  const sshBefore = before.ssh_config;
  const sshAfter = after.ssh_config;
  if (!sshBefore || !sshAfter) return !!sshBefore !== !!sshAfter;
  if (sshAfter.password || sshAfter.passphrase) return true;
  return sshBefore.host !== sshAfter.host
    || sshBefore.port !== sshAfter.port
    || sshBefore.username !== sshAfter.username
    || (sshBefore.private_key_path ?? null) !== (sshAfter.private_key_path ?? null);
}
