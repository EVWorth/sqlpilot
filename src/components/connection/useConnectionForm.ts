import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/utils";
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

/** The charset a profile gets when the field is left empty. */
const DEFAULT_CHARSET = "utf8mb4";

const defaultProfile: Omit<ConnectionProfileInput, "id" | "created_at" | "updated_at"> = {
  name: "",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "",
  default_database: "",
  read_only: false,
  connect_timeout_secs: 10,
  query_timeout_secs: 0,
  charset: DEFAULT_CHARSET,
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

/**
 * A copy of a profile, ready to be saved as a new one.
 *
 * Everything but the identity and the credentials: the password lives in the
 * keyring under the original's id, so the copy needs its own (FR-1.1.4).
 */
function toCopy(profile: ConnectionProfile): ConnectionProfileInput {
  return {
    ...toInput(profile),
    id: crypto.randomUUID(),
    name: `${profile.name} (copy)`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function initialForm(
  editProfile?: ConnectionProfile,
  duplicateOf?: ConnectionProfile,
): ConnectionProfileInput {
  if (editProfile) return toInput(editProfile);
  if (duplicateOf) return toCopy(duplicateOf);
  return blankProfile();
}

/** The number fields, which are typed as text and parsed when valid. */
export type NumberField = "port" | "connect_timeout_secs" | "query_timeout_secs";

/** What is wrong with a number field's text, if anything. */
function numberProblem(field: NumberField, text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return "Required";
  if (!/^\d+$/.test(trimmed)) return "Must be a whole number";
  const n = Number(trimmed);
  if (field === "port") {
    return n >= 1 && n <= 65535 ? undefined : "Must be between 1 and 65535";
  }
  if (field === "connect_timeout_secs") {
    return n >= 1 ? undefined : "Must be at least 1";
  }
  return undefined;
}

/** The text each number field starts with. */
function numberTexts(form: ConnectionProfileInput): Record<NumberField, string> {
  return {
    port: String(form.port),
    connect_timeout_secs: String(form.connect_timeout_secs ?? 10),
    query_timeout_secs: String(form.query_timeout_secs ?? 0),
  };
}

export function useConnectionForm(
  isOpen: boolean,
  editProfile?: ConnectionProfile,
  duplicateOf?: ConnectionProfile,
) {
  const [form, setForm] = useState<ConnectionProfileInput>(
    initialForm(editProfile, duplicateOf),
  );
  const [sshEnabled, setSshEnabled] = useState(
    !!(editProfile ?? duplicateOf)?.ssh_config,
  );
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key">(
    (editProfile ?? duplicateOf)?.ssh_config?.private_key_path ? "key" : "password",
  );
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // What is typed in the number fields, kept apart from the form so that
  // clearing one to type a new value does not snap it back to a default
  // (#813). The form only takes the value once it parses.
  const [numberText, setNumberText] = useState<Record<NumberField, string>>(
    () => numberTexts(initialForm(editProfile, duplicateOf)),
  );
  const saveProfile = useConnectionStore((s) => s.saveProfile);
  const testConnection = useConnectionStore((s) => s.testConnection);

  // Reopening is a fresh start, whether that is a new profile or the same one
  // again after an edit was abandoned.
  useEffect(() => {
    if (!isOpen) return;
    const next = initialForm(editProfile, duplicateOf);
    setForm(next);
    setNumberText(numberTexts(next));
    const ssh = (editProfile ?? duplicateOf)?.ssh_config;
    setSshEnabled(!!ssh);
    setSshAuthMethod(ssh?.private_key_path ? "key" : "password");
    setTestResult(null);
    setSaveError(null);
  }, [isOpen, editProfile, duplicateOf]);

  const handleChange = (
    field: keyof ConnectionProfileInput,
    value: string | number | boolean | undefined,
  ) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // What was tested is no longer what is in the form.
    setTestResult(null);
  };

  const handleNumberChange = (field: NumberField, text: string) => {
    setNumberText((prev) => ({ ...prev, [field]: text }));
    if (numberProblem(field, text) === undefined) {
      setForm((prev) => ({ ...prev, [field]: Number(text.trim()) }));
    }
    setTestResult(null);
  };

  const numberProblems: Partial<Record<NumberField, string>> = {};
  for (const field of Object.keys(numberText) as NumberField[]) {
    const problem = numberProblem(field, numberText[field]);
    if (problem !== undefined) numberProblems[field] = problem;
  }
  const numbersValid = Object.keys(numberProblems).length === 0;

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
    // The field is free text while typing; an empty one means the default.
    profile.charset = profile.charset?.trim() || DEFAULT_CHARSET;
    return profile;
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await testConnection(buildProfileForSave()));
    setTesting(false);
  };

  /** Save, then hand `onDone` what was saved. */
  const handleSave = async (onDone: (saved: ConnectionProfileInput) => void) => {
    setSaving(true);
    setSaveError(null);
    try {
      const profile = buildProfileForSave();
      await saveProfile(profile);
      setSaving(false);
      onDone(profile);
    } catch (e) {
      // Stay open, so what was typed is not lost, and say why (#792).
      setSaveError(errorMessage(e));
      setSaving(false);
    }
  };

  return {
    form,
    sshEnabled,
    setSshEnabled,
    sshAuthMethod,
    setSshAuthMethod,
    testResult,
    testing,
    saving,
    saveError,
    numberText,
    numberProblems,
    canSave: !saving && !!form.name && !!form.host && numbersValid,
    canTest: !testing && numbersValid,
    handleChange,
    handleNumberChange,
    handleSSLChange,
    handleSSHChange,
    handleTest,
    handleSave,
  };
}
