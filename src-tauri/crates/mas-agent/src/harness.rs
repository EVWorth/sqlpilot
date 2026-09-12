//! Which harnesses are on this machine, and how to start one.
//!
//! BYOH means SQLPilot never installs, updates or authenticates an agent. It
//! looks for the CLI the user already has, and if it is not there it says so
//! with the command that installs it — rather than offering to do it, which
//! would make SQLPilot responsible for a tool it does not own.

use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};

/// A harness SQLPilot knows how to run in-app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum Harness {
    /// Anthropic's CLI. Spoken to over its own NDJSON stream.
    ClaudeCode,
    /// GitHub's CLI. Spoken to over the Agent Client Protocol.
    Copilot,
}

impl Harness {
    pub fn command(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "claude",
            Harness::Copilot => "copilot",
        }
    }

    /// What to call it in the UI.
    ///
    /// "Claude Agent" rather than "Claude Code": the branding guidance does
    /// not permit a third-party product to label a feature with the product
    /// name, and this is a session running in SQLPilot.
    pub fn label(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "Claude Agent",
            Harness::Copilot => "GitHub Copilot",
        }
    }

    /// How the user would install it, for the "not found" message.
    pub fn install_hint(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "npm install -g @anthropic-ai/claude-code",
            Harness::Copilot => "npm install -g @github/copilot",
        }
    }

    pub const ALL: [Harness; 2] = [Harness::ClaudeCode, Harness::Copilot];
}

/// Whether a harness is usable, and what version.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub harness: Harness,
    pub label: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Set when it is not installed: what to run to get it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<String>,
}

/// Look for each harness.
///
/// Sequential rather than concurrent: there are two of them, each is one
/// process, and this runs when a settings screen opens rather than in a hot
/// path.
pub async fn discover() -> Vec<HarnessStatus> {
    let mut found = Vec::new();
    for harness in Harness::ALL {
        let version = version_of(harness).await;
        found.push(HarnessStatus {
            installed: version.is_some(),
            install_hint: version
                .is_none()
                .then(|| harness.install_hint().to_string()),
            label: harness.label().to_string(),
            harness,
            version,
        });
    }
    found
}

/// The version string a harness reports, or None if it is not there.
///
/// `--version` rather than `which`: a command on the PATH that cannot run —
/// the wrong architecture, a broken npm link, a shim pointing at a deleted
/// node — is not an installed harness, and finding that out at spawn time
/// means finding out in the middle of a user's first message.
pub async fn version_of(harness: Harness) -> Option<String> {
    version_of_command(harness.command()).await
}

/// As [`version_of`], for a command named directly. Split out so the "not
/// there" and "there but broken" paths can be tested without depending on
/// which harnesses this machine happens to have.
pub async fn version_of_command(command: &str) -> Option<String> {
    let output = Command::new(command)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|line| line.trim().to_string())
}

/// Start a harness as an ACP agent.
///
/// Only Copilot speaks ACP today. Claude Code has its own adapter.
pub fn spawn_acp(harness: Harness, cwd: &str) -> std::io::Result<Child> {
    Command::new(harness.command())
        .arg("--acp")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Inherited rather than piped: the agent's diagnostics belong in the
        // app's log, and a piped stderr nobody reads fills its buffer and
        // blocks the process.
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_harness_has_a_command_and_a_way_to_install_it() {
        for harness in Harness::ALL {
            assert!(!harness.command().is_empty());
            assert!(harness.install_hint().contains("install"));
        }
    }

    #[test]
    fn the_label_is_not_the_product_name() {
        // The branding guidance does not permit a third-party product to label
        // a feature "Claude Code".
        assert_eq!(Harness::ClaudeCode.label(), "Claude Agent");
    }

    #[test]
    fn a_harness_round_trips_through_the_wire_shape() {
        let json = serde_json::to_string(&Harness::ClaudeCode).unwrap();
        assert_eq!(json, "\"claude-code\"");
        assert_eq!(
            serde_json::from_str::<Harness>(&json).unwrap(),
            Harness::ClaudeCode
        );
    }

    #[tokio::test]
    async fn discovery_answers_for_every_harness_whatever_is_installed() {
        // Not an error to be missing: most machines have one of these two, not
        // both, and the screen needs a row for each either way.
        let found = discover().await;
        assert_eq!(found.len(), Harness::ALL.len());
        for status in found {
            assert_eq!(status.installed, status.version.is_some());
            // Exactly one of the two is shown: a version, or how to get one.
            assert_eq!(status.installed, status.install_hint.is_none());
        }
    }

    #[tokio::test]
    async fn a_command_that_does_not_exist_is_not_installed() {
        assert!(version_of_command("sqlpilot-no-such-harness")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn a_command_that_fails_is_not_installed_either() {
        // `which` says yes to a broken npm shim or a wrong-architecture
        // binary. Running it says no, which is the answer that matters —
        // otherwise the failure lands in the middle of a user's first message.
        assert!(version_of_command("false").await.is_none());
    }

    #[tokio::test]
    async fn a_version_is_the_first_line_and_nothing_else() {
        // Copilot prints an update notice on the second line. Taking the whole
        // output would put "Run `copilot update`" in the settings screen.
        // `echo --version` is GNU echo reporting itself, over several lines.
        let version = version_of_command("echo").await.expect("echo is there");
        assert!(version.starts_with("echo (GNU"), "{version}");
        assert!(!version.contains('\n'));
    }
}
