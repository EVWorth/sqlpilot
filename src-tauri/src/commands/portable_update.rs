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
//! `Portable`. The file handling is in `mas-update`, which `Test Windows` in
//! CI runs on a real Windows host.

use mas_update::{clear_leftovers, stage, swap};
use serde::{Deserialize, Serialize};
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

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("SQLPilot.exe");
        std::fs::write(&exe, b"old").unwrap();
        (dir, exe)
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
