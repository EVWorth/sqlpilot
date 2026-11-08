//! A running program replaces its own file and restarts, for real.
//!
//! The other tests move files around from outside. What an update depends on
//! is what the OS does to a program that is running, most of all on Windows:
//! that its exe can be renamed, that the new one starts from the same path,
//! and that the old file can be deleted once it has exited. So this test
//! copies its own binary into a temporary folder and runs the copy as the
//! program being updated. CI runs it on Windows (`Test Windows`).

use mas_update::{clear_leftovers, retired_path, stage, staged_path, swap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const FOLDER: &str = "MAS_UPDATE_SELF_SWAP_FOLDER";
const RELAUNCHED: &str = "MAS_UPDATE_SELF_SWAP_RELAUNCHED";
const HELPER: &str = "acts_as_the_program_being_updated";

/// Added to the new exe, so it differs from the old one while still running.
const NEW_VERSION_MARKER: &[u8] = b"new-version";

fn helper_command(exe: &Path, folder: &Path) -> Command {
    let mut command = Command::new(exe);
    command
        .args(["--exact", HELPER, "--ignored", "--nocapture"])
        .env(FOLDER, folder);
    command
}

/// Not a test by itself: `a_running_exe_replaces_itself` runs it twice, as the
/// old version and then as the new one.
#[test]
#[ignore = "run by a_running_exe_replaces_itself"]
#[allow(clippy::zombie_processes)]
fn acts_as_the_program_being_updated() {
    let folder = PathBuf::from(std::env::var_os(FOLDER).expect("run by the parent test"));
    let exe = std::env::current_exe().unwrap();

    if std::env::var_os(RELAUNCHED).is_none() {
        // As the app's apply command: the path is read before the swap.
        // The new version outlives this process, as it does in the app, so it
        // is deliberately not waited for.
        swap(&exe).unwrap();
        helper_command(&exe, &folder)
            .env(RELAUNCHED, "1")
            .spawn()
            .unwrap();
        return;
    }

    // The new version. The old process may still be exiting, as at a real
    // launch, so this retries the same way the app does.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut cleared = clear_leftovers(&exe);
    while !cleared && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        cleared = clear_leftovers(&exe);
    }
    std::fs::write(
        folder.join("relaunched"),
        format!("{}|{cleared}", exe.display()),
    )
    .unwrap();
}

#[test]
fn a_running_exe_replaces_itself() {
    let dir = tempfile::tempdir().unwrap();
    let name = format!("App{}", std::env::consts::EXE_SUFFIX);
    let exe = dir.path().join(name);
    std::fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();

    let mut new_version = std::fs::read(&exe).unwrap();
    new_version.extend_from_slice(NEW_VERSION_MARKER);
    stage(&exe, &new_version).unwrap();

    let status = helper_command(&exe, dir.path()).status().unwrap();
    assert!(status.success(), "the old version failed: {status}");

    let report = dir.path().join("relaunched");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !report.exists() {
        assert!(Instant::now() < deadline, "the new version never started");
        std::thread::sleep(Duration::from_millis(100));
    }
    // Written and read across processes, so wait out a half-finished write.
    let mut text = std::fs::read_to_string(&report).unwrap();
    while !text.contains('|') && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        text = std::fs::read_to_string(&report).unwrap();
    }
    let (ran_from, cleared) = text.split_once('|').unwrap();

    assert_eq!(
        Path::new(ran_from).canonicalize().unwrap(),
        exe.canonicalize().unwrap(),
        "the new version must run from the path the user launches"
    );
    assert_eq!(
        std::fs::read(&exe).unwrap(),
        new_version,
        "the launch path must hold the new file"
    );
    assert_eq!(cleared, "true", "the old file was never removable");
    assert!(!retired_path(&exe).exists());
    assert!(!staged_path(&exe).exists());
}
