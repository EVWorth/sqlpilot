import { useEffect, useState } from "react";
import { validatePoolSizing } from "../../lib/connection-validation";
import { api } from "../../lib/tauri-api";
import { useConnectionStore } from "../../stores/connectionStore";
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  SSHConfigInput,
  SSLConfig,
  TestConnectionResult,
} from "../../types";

/**
 * Everything the connection dialog knows, apart from how it looks.
 *
 * The dialog was one 700-line file holding four tabs, nine pieces of state
 * and six handlers, so adding a fifth tab meant reading all of it (#275).
 * The state and the rules live here; each tab is a component that takes what
 * it needs.
 */

const defaultProfile: Omit<ConnectionProfileInput, "id" | "created_at" | "updated_at"> = {
  name: "",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "",
  default_database: "",
  pool_min: 1,
  pool_max: 5,
  read_only: false,
  connect_timeout_secs: 10,
  query_timeout_secs: 0,
  charset: "utf8mb4",
  // Rust Options are required-but-nullable, so these are stated explicitly
  // instead of being left off as they were with the hand-written type.
  group: null,
  color: null,
  environment: null,
  ssh_config: null,
  ssl_config: null,
};

/**
 * Drop keys whose value is `undefined`.
 *
 * The generated types spell optional fields `T | null` (Rust's Option), but
 * `Partial<T>` spells them `T | undefined`. Spreading a Partial over a full
 * object would therefore reintroduce `undefined` where only `null` is valid.
 */
function definedOnly<T extends object>(updates: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** A blank profile, with the identity fields a save needs. */
function blankProfile(): ConnectionProfileInput {
  return {
    ...defaultProfile,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Seed the editable form from a saved profile.
 *
 * A saved profile has no credentials — the backend never sends them back — so
 * they start blank. That is the protocol `save_connection_profile` expects:
 * an empty password means "keep the stored one".
 */
function toInput(profile: ConnectionProfile): ConnectionProfileInput {
  return {
    ...profile,
    password: "",
    ssh_config: profile.ssh_config
      ? { ...profile.ssh_config, password: null, passphrase: null }
      : null,
  };
}

export function useConnectionForm(isOpen: boolean, editProfile?: ConnectionProfile) {
  const [form, setForm] = useState<ConnectionProfileInput>(
    editProfile ? toInput(editProfile) : blankProfile(),
  );
  const [sshEnabled, setSshEnabled] = useState(!!editProfile?.ssh_config);
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key">(
    editProfile?.ssh_config?.private_key_path ? "key" : "password",
  );
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveProfile = useConnectionStore((s) => s.saveProfile);

  // Reopening is a fresh start, whether that is a new profile or the same one
  // again after an edit was abandoned.
  useEffect(() => {
    if (!isOpen) return;
    setForm(editProfile ? toInput(editProfile) : blankProfile());
    setSshEnabled(!!editProfile?.ssh_config);
    setSshAuthMethod(editProfile?.ssh_config?.private_key_path ? "key" : "password");
    setTestResult(null);
  }, [isOpen, editProfile]);

  const handleChange = (
    field: keyof ConnectionProfileInput,
    value: string | number | boolean | undefined,
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // What was tested is no longer what is in the form.
    setTestResult(null);
  };

  const handleSSLChange = (updates: Partial<SSLConfig>) => {
    setForm((prev) => {
      // Start from a complete SSLConfig: the generated type requires every
      // field to be present (nullable, not optional), so spreading a possibly
      // null prev.ssl_config directly would leave them optional.
      const base: SSLConfig = prev.ssl_config ?? {
        mode: "Disabled",
        ca_cert_path: null,
        client_cert_path: null,
        client_key_path: null,
      };
      return { ...prev, ssl_config: { ...base, ...definedOnly(updates) } };
    });
    setTestResult(null);
  };

  const handleSSHChange = (updates: Partial<SSHConfigInput>) => {
    setForm((prev) => {
      const base: SSHConfigInput = prev.ssh_config ?? {
        host: "",
        port: 22,
        username: "",
        private_key_path: null,
      };
      return { ...prev, ssh_config: { ...base, ...definedOnly(updates) } };
    });
    setTestResult(null);
  };

  /** The profile as it would be stored, with the irrelevant parts cleared. */
  const buildProfileForSave = (): ConnectionProfileInput => {
    const profile = { ...form };
    if (!sshEnabled) {
      profile.ssh_config = null;
    } else if (profile.ssh_config) {
      // Only the fields the chosen method uses, so switching between them
      // does not leave a stale key path or password behind.
      profile.ssh_config = sshAuthMethod === "password"
        ? { ...profile.ssh_config, private_key_path: null, passphrase: null }
        : { ...profile.ssh_config, password: null };
    }
    if (!profile.ssl_config || profile.ssl_config.mode === "Disabled") {
      profile.ssl_config = null;
    }
    return profile;
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testConnection(buildProfileForSave()));
    } catch (e) {
      setTestResult({ success: false, message: String(e), server_version: null, latency_ms: 0 });
    }
    setTesting(false);
  };

  const handleSave = async (onDone: () => void) => {
    setSaving(true);
    try {
      await saveProfile(buildProfileForSave());
      onDone();
    } catch (e) {
      console.error("Save failed:", e);
    }
    setSaving(false);
  };

  // Checked as they are typed, so the answer is beside the field rather than
  // a connection that fails later or a number quietly changed on the way in.
  const poolProblems = validatePoolSizing(form.pool_min, form.pool_max);

  return {
    form,
    sshEnabled,
    setSshEnabled,
    sshAuthMethod,
    setSshAuthMethod,
    testResult,
    testing,
    saving,
    poolProblems,
    canSave: !saving && !!form.name && !!form.host
      && Object.keys(poolProblems).length === 0,
    handleChange,
    handleSSLChange,
    handleSSHChange,
    handleTest,
    handleSave,
  };
}
