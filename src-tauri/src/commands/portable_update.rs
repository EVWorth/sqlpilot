//! Updating the standalone `SQLPilot.exe`, which has no installer to run.
//!
//! The updater plugin knows how to run an MSI or an NSIS setup. Given a copy
//! nobody installed, that turns a file the user put somewhere on purpose into
//! a second, installed copy, and leaves the original behind on the old
//! version. So this copy replaces its own file instead. The plugin still does
//! the part that matters for safety: `Update::download` verifies the minisign
//! signature against the public key in `tauri.conf.json` before handing over
//! any bytes. Only `Update::install` is skipped.
//!
//! Two steps, matching the installers' "download, then restart when asked":
//!
//! 1. Download writes the verified bytes next to the exe. Being on the same
//!    volume makes the later rename atomic, and writing there now finds out
//!    about a read-only folder before anyone is asked to restart.
//! 2. Apply swaps the files, starts the new exe and exits.
//!
//! Windows lets a running exe be renamed but not deleted or overwritten, so
//! the old file is moved aside and removed by the next launch.
//!
//! Nothing here is `cfg(windows)`: only `detect_package_format` ever answers
//! `Portable`, and the file handling is the same everywhere, so it is tested
//! wherever `cargo test` runs. CI has no Windows job for it to wait on.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;
use tauri_specta::Event as _;

use super::{detect_package_format, PackageFormat, RealProbe};

/// The `latest.json` key for this format. `scripts/build-update-manifest.sh`
/// writes it. The plugin never looks it up by itself, so copies that update
/// through an installer are unaffected by its being there.
const PORTABLE_TARGET: &str = "windows-x86_64-portable";

/// Progress is drawn as a bar, and a chunk can be a few kilobytes. Thousands
/// of events for one download would be work for nothing.
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

/// How often, and how far apart, a launch tries to remove the old exe. The
/// process that was running it may still be exiting when this one starts.
const CLEANUP_ATTEMPTS: u32 = 10;
const CLEANUP_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

/// How much of the new exe has arrived. Floats because specta refuses to
/// describe a `u64` to TypeScript, and an exe is nowhere near 2^53 bytes.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct PortableUpdateProgress {
    pub transferred: f64,
    pub total: Option<f64>,
}

/// `SQLPilot.exe` + `.update` beside it, keeping whatever name the user gave
/// the file.
fn beside(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.file_name().map(OsString::from).unwrap_or_default();
    name.push(suffix);
    exe.with_file_name(name)
}

/// Where a download lands while it is being written.
fn partial_path(exe: &Path) -> PathBuf {
    beside(exe, ".update.partial")
}

/// A complete, signature-checked new exe, waiting for a restart.
fn staged_path(exe: &Path) -> PathBuf {
    beside(exe, ".update")
}

/// The exe that was replaced, until a later launch can delete it.
fn retired_path(exe: &Path) -> PathBuf {
    beside(exe, ".old")
}

/// Put the new exe beside the current one. It only takes the staged name once
/// it is complete and on disk, so a crash mid-write cannot leave something a
/// later swap would run.
fn stage(exe: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = partial_path(exe);
    let written = (|| {
        let mut file = std::fs::File::create(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()
    })()
    .and_then(|()| std::fs::rename(&partial, staged_path(exe)));
    if written.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    written
}

/// Move the running exe aside and the staged one into its place.
///
/// If the second rename fails the first is undone, because the alternative is
/// no exe at the path the user launches. The staged file is left where it is,
/// so trying again does not mean downloading again.
fn swap(exe: &Path) -> std::io::Result<()> {
    swap_using(exe, |from, to| std::fs::rename(from, to))
}

/// `swap`, with the rename passed in so a test can make one of the two fail.
fn swap_using(
    exe: &Path,
    rename: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let staged = staged_path(exe);
    if !staged.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the downloaded update is no longer there",
        ));
    }
    let retired = retired_path(exe);
    // Left by an earlier update whose cleanup never got to it. A rename onto
    // it would fail on Windows if something still holds it open, and that
    // failure is better reported by the rename below than guessed at here.
    let _ = std::fs::remove_file(&retired);
    rename(exe, &retired)?;
    if let Err(e) = rename(&staged, exe) {
        if let Err(undo) = rename(&retired, exe) {
            tracing::error!(error = %undo, "could not put the old exe back");
        }
        return Err(e);
    }
    Ok(())
}

/// Remove what an earlier update left behind. True when nothing remains.
///
/// A staged file is removed too. It belonged to a download nobody restarted
/// for, and the check that follows this launch will offer whatever is newest.
fn clear_leftovers(exe: &Path) -> bool {
    [partial_path(exe), staged_path(exe), retired_path(exe)]
        .iter()
        .fold(true, |clear, path| match std::fs::remove_file(path) {
            Ok(()) => clear,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => clear,
            Err(e) => {
                tracing::debug!(error = %e, path = %path.display(), "leftover not removed yet");
                false
            }
        })
}

/// The path of this exe, refusing outright for any copy that is not the
/// standalone one. An installed copy replacing its own file would fall out of
/// step with what its installer recorded.
fn portable_exe() -> Result<PathBuf, String> {
    if detect_package_format(&RealProbe) != PackageFormat::Portable {
        return Err("Only the standalone SQLPilot.exe updates this way.".to_string());
    }
    std::env::current_exe().map_err(|e| format!("Could not find this copy of SQLPilot: {e}"))
}

/// What to tell the user when the new exe cannot be written. Falling back to
/// the installer here would be the thing this module exists to prevent, so
/// they get the two things that do work instead.
fn stage_error(exe: &Path, error: &std::io::Error) -> String {
    let folder = exe
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "this folder".to_string());
    format!(
        "SQLPilot could not save the update in {folder}: {error}. Move SQLPilot.exe to a folder \
         you can write to, or download the new SQLPilot.exe from the release page."
    )
}

/// On launch, in the background, clear what the last update left. Does nothing
/// for an installed copy, whose folder is not this module's to tidy.
pub fn clean_up_after_update() {
    let Ok(exe) = portable_exe() else { return };
    std::thread::spawn(move || {
        for attempt in 0..CLEANUP_ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(CLEANUP_DELAY);
            }
            if clear_leftovers(&exe) {
                return;
            }
        }
        // Harmless, and the next launch tries again.
        tracing::warn!("the previous version's exe could not be removed yet");
    });
}

/// Download the newest standalone exe and stage it beside this one. Returns
/// the version, which may be newer than the one the user was offered if a
/// release went out since the check.
#[tauri::command]
#[tracing::instrument(skip(app))]
#[specta::specta]
pub async fn download_portable_update(app: AppHandle) -> Result<String, String> {
    let exe = portable_exe()?;
    let update = app
        .updater_builder()
        .target(PORTABLE_TARGET)
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "There is no newer version to download any more.".to_string())?;
    let version = update.version.clone();

    let emit = app.clone();
    let mut transferred = 0u64;
    let mut reported = 0u64;
    let bytes = update
        .download(
            move |chunk, total| {
                transferred += chunk as u64;
                if transferred - reported >= PROGRESS_STEP_BYTES || Some(transferred) == total {
                    reported = transferred;
                    // A missed event costs a jump in a progress bar, and the
                    // download is what matters.
                    let _ = PortableUpdateProgress {
                        transferred: transferred as f64,
                        total: total.map(|t| t as f64),
                    }
                    .emit(&emit);
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    let stage_exe = exe.clone();
    tokio::task::spawn_blocking(move || stage(&stage_exe, &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| stage_error(&exe, &e))?;
    tracing::info!(%version, "standalone update staged");
    Ok(version)
}

/// Swap in the staged exe, start it, and exit.
///
/// Started from the path read before the swap, rather than through
/// `AppHandle::restart`, which asks the OS where the running exe is when it is
/// called. By then that exe has been renamed. This way the answer cannot
/// matter, and starting the `.old` file would look like an update that did
/// nothing.
#[tauri::command]
#[tracing::instrument(skip(app))]
#[specta::specta]
pub fn apply_portable_update(app: AppHandle) -> Result<(), String> {
    let exe = portable_exe()?;
    swap(&exe).map_err(|e| format!("SQLPilot could not replace its own file: {e}."))?;
    std::process::Command::new(&exe)
        .args(std::env::args_os().skip(1))
        .spawn()
        .map_err(|e| {
            format!(
                "The update is installed but the app could not restart itself: {e}. Quit and \
                 reopen SQLPilot to finish."
            )
        })?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder holding a pretend running exe.
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("SQLPilot.exe");
        std::fs::write(&exe, b"old").unwrap();
        (dir, exe)
    }

    fn contents(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap()
    }

    #[test]
    fn staging_leaves_the_running_exe_alone() {
        let (_dir, exe) = fixture();
        stage(&exe, b"new").unwrap();
        assert_eq!(contents(&exe), b"old");
        assert_eq!(contents(&staged_path(&exe)), b"new");
        assert!(!partial_path(&exe).exists());
    }

    #[test]
    fn a_failed_stage_reports_the_error_and_stages_nothing() {
        let dir = tempfile::tempdir().unwrap();
        // The folder does not exist, which fails the write the way a
        // read-only one does on every platform, including as root.
        let exe = dir.path().join("missing").join("SQLPilot.exe");
        assert!(stage(&exe, b"new").is_err());
        assert!(!staged_path(&exe).exists());
    }

    #[test]
    fn the_swap_puts_the_new_exe_at_the_path_the_user_launches() {
        let (_dir, exe) = fixture();
        stage(&exe, b"new").unwrap();
        swap(&exe).unwrap();
        assert_eq!(contents(&exe), b"new");
        assert_eq!(contents(&retired_path(&exe)), b"old");
        assert!(!staged_path(&exe).exists());
    }

    #[test]
    fn the_swap_keeps_a_name_the_user_chose() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("sqlpilot-work.exe");
        std::fs::write(&exe, b"old").unwrap();
        stage(&exe, b"new").unwrap();
        swap(&exe).unwrap();
        assert_eq!(contents(&exe), b"new");
        assert!(dir.path().join("sqlpilot-work.exe.old").exists());
    }

    #[test]
    fn with_nothing_staged_the_swap_fails_and_changes_nothing() {
        let (_dir, exe) = fixture();
        assert!(swap(&exe).is_err());
        assert_eq!(contents(&exe), b"old");
        assert!(!retired_path(&exe).exists());
    }

    #[test]
    fn a_failed_swap_puts_the_old_exe_back_and_keeps_the_download() {
        let (_dir, exe) = fixture();
        stage(&exe, b"new").unwrap();
        // Refuse only the rename that brings the new exe in, which is the
        // moment the path the user launches has nothing at it.
        let staged = staged_path(&exe);
        let result = swap_using(&exe, |from, to| {
            if from == staged {
                Err(std::io::Error::other("refused"))
            } else {
                std::fs::rename(from, to)
            }
        });
        assert!(result.is_err());
        assert_eq!(contents(&exe), b"old");
        assert_eq!(contents(&staged), b"new");
        assert!(!retired_path(&exe).exists());
    }

    #[test]
    fn when_the_old_exe_cannot_be_moved_nothing_changes() {
        let (_dir, exe) = fixture();
        stage(&exe, b"new").unwrap();
        let result = swap_using(&exe, |_, _| Err(std::io::Error::other("refused")));
        assert!(result.is_err());
        assert_eq!(contents(&exe), b"old");
        assert_eq!(contents(&staged_path(&exe)), b"new");
    }

    #[test]
    fn a_second_update_replaces_a_leftover_old_exe() {
        let (_dir, exe) = fixture();
        std::fs::write(retired_path(&exe), b"older").unwrap();
        stage(&exe, b"new").unwrap();
        swap(&exe).unwrap();
        assert_eq!(contents(&retired_path(&exe)), b"old");
    }

    #[test]
    fn cleanup_removes_every_leftover_and_never_the_exe() {
        let (_dir, exe) = fixture();
        for path in [partial_path(&exe), staged_path(&exe), retired_path(&exe)] {
            std::fs::write(path, b"x").unwrap();
        }
        assert!(clear_leftovers(&exe));
        assert_eq!(contents(&exe), b"old");
        assert!(!partial_path(&exe).exists());
        assert!(!staged_path(&exe).exists());
        assert!(!retired_path(&exe).exists());
    }

    #[test]
    fn cleanup_with_nothing_to_do_is_clear() {
        let (_dir, exe) = fixture();
        assert!(clear_leftovers(&exe));
    }

    #[test]
    fn cleanup_reports_a_leftover_it_could_not_remove() {
        let (_dir, exe) = fixture();
        // A directory cannot be removed by remove_file: the same answer as a
        // file still held open by the exiting process.
        std::fs::create_dir(retired_path(&exe)).unwrap();
        assert!(!clear_leftovers(&exe));
    }

    #[test]
    fn the_write_error_names_the_folder_and_what_to_do() {
        let (_dir, exe) = fixture();
        let message = stage_error(&exe, &std::io::Error::other("denied"));
        assert!(message.contains(&exe.parent().unwrap().display().to_string()));
        assert!(message.contains("denied"));
        assert!(message.contains("release page"));
    }
}
