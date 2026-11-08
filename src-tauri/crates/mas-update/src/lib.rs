//! Replacing a running program's own file, without Tauri.
//!
//! Windows lets a running exe be renamed but not deleted or overwritten, so an
//! update moves the old file aside and the next launch removes it. Staging on
//! the same volume makes the final rename atomic.
//!
//! Apart from the app so that it can be tested where it matters. Tauri test
//! binaries are awkward to start on Windows, and `tests/self_swap.rs` needs a
//! program that really does replace itself while running.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// `SQLPilot.exe` + `.update` beside it, keeping whatever name the user gave
/// the file.
fn beside(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.file_name().map(OsString::from).unwrap_or_default();
    name.push(suffix);
    exe.with_file_name(name)
}

/// Where a download lands while it is being written.
pub fn partial_path(exe: &Path) -> PathBuf {
    beside(exe, ".update.partial")
}

/// A complete, signature-checked new exe, waiting for a restart.
pub fn staged_path(exe: &Path) -> PathBuf {
    beside(exe, ".update")
}

/// The exe that was replaced, until a later launch can delete it.
pub fn retired_path(exe: &Path) -> PathBuf {
    beside(exe, ".old")
}

/// Put the new exe beside the current one. It only takes the staged name once
/// it is complete and on disk, so a crash mid-write cannot leave something a
/// later swap would run.
pub fn stage(exe: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = partial_path(exe);
    let written = (|| {
        let mut file = std::fs::File::create(&partial)?;
        file.write_all(bytes)?;
        // A freshly created file need not be runnable. The new exe should be
        // exactly as runnable as the one it replaces.
        file.set_permissions(std::fs::metadata(exe)?.permissions())?;
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
pub fn swap(exe: &Path) -> std::io::Result<()> {
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
pub fn clear_leftovers(exe: &Path) -> bool {
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

    #[cfg(unix)]
    #[test]
    fn the_staged_exe_is_as_runnable_as_the_old_one() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, exe) = fixture();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        stage(&exe, b"new").unwrap();
        let mode = std::fs::metadata(staged_path(&exe))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
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
}
