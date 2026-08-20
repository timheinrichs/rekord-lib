//! Guard for the bundled `ffmpeg`/`ffprobe` sidecars.
//!
//! The sidecars in `binaries/` must be **self-contained**: linked only against
//! system libraries (`/usr/lib`, `/System/…`). A Homebrew-built binary links
//! against `/opt/homebrew/…` dylibs that only exist on the build machine, so it
//! crashes with `dyld: Library not loaded` on any device without an identical
//! Homebrew install — analysis and conversion then fail silently for users.
//!
//! The test below runs in CI (`cargo test` on the macOS runner) and fails the
//! build if a non-self-contained sidecar ever gets committed again. What it
//! cannot check is the machine the app ends up on, which is what [`self_test`]
//! is for: it runs both binaries once at startup, so a bundle that cannot use
//! them says so instead of failing every analysis and conversion quietly.

use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Outcome of the startup self-test: `Some(message)` once a sidecar has been
/// found unusable, `None` while everything works — or before the test has
/// finished, which is why the check runs early and off the launch path.
#[derive(Default)]
pub struct SidecarState(pub Mutex<Option<String>>);

/// Runs both sidecars once and returns the first failure.
///
/// `-version` is enough: what goes wrong in the field is the binary not
/// starting at all (`dyld: Library not loaded` from a dependency that only
/// existed on the build machine, a missing quarantine exemption, a wrong
/// architecture), and that fails before any argument matters.
pub async fn self_test(app: &AppHandle) -> Result<(), String> {
    for name in ["ffprobe", "ffmpeg"] {
        let command = app
            .shell()
            .sidecar(name)
            .map_err(|e| format!("{name} is not bundled with the app: {e}"))?;
        let output = command
            .arg("-version")
            .output()
            .await
            .map_err(|e| format!("{name} could not be started: {e}"))?;
        if !output.status.success() {
            return Err(failure_message(
                name,
                output.status.code(),
                &String::from_utf8_lossy(&output.stderr),
            ));
        }
    }
    Ok(())
}

/// Why a sidecar could not be used, as a line worth showing the user.
fn failure_message(name: &str, code: Option<i32>, stderr: &str) -> String {
    let detail = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    if !detail.is_empty() {
        // The first line is the one that says why — a dyld error prints the
        // missing library there and the search paths below it.
        return format!("{name} failed to run: {detail}");
    }
    match code {
        Some(code) => format!("{name} failed to run (exit code {code})"),
        None => format!("{name} was stopped before it could report a version"),
    }
}

#[cfg(test)]
mod message_tests {
    use super::failure_message;

    #[test]
    fn reports_what_the_loader_said() {
        let stderr = "dyld: Library not loaded: /opt/homebrew/opt/lame/lib/libmp3lame.0.dylib\n  Referenced from: ffmpeg";
        assert_eq!(
            failure_message("ffmpeg", None, stderr),
            "ffmpeg failed to run: dyld: Library not loaded: /opt/homebrew/opt/lame/lib/libmp3lame.0.dylib"
        );
    }

    #[test]
    fn falls_back_to_the_exit_status() {
        // A silent failure still has to name the binary — that is the part the
        // user can act on ("reinstall the app"), and an exit code alone does not.
        assert_eq!(
            failure_message("ffprobe", Some(1), "  \n"),
            "ffprobe failed to run (exit code 1)"
        );
        assert_eq!(
            failure_message("ffprobe", None, ""),
            "ffprobe was stopped before it could report a version"
        );
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use std::path::PathBuf;
    use std::process::Command;

    /// The distribution target these sidecars are built for.
    const TARGET: &str = "aarch64-apple-darwin";

    fn sidecar_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{name}-{TARGET}"))
    }

    /// Dependencies outside these prefixes are not guaranteed to exist on a
    /// clean macOS install and would make the sidecar non-portable.
    fn non_system_deps(binary: &PathBuf) -> Vec<String> {
        let output = Command::new("otool")
            .arg("-L")
            .arg(binary)
            .output()
            .expect("otool must be available on the macOS build/test host");
        assert!(
            output.status.success(),
            "otool -L failed for {}",
            binary.display()
        );

        String::from_utf8_lossy(&output.stdout)
            .lines()
            // First line is the binary path itself, not a dependency.
            .skip(1)
            .filter_map(|line| line.trim().split_whitespace().next())
            .filter(|dep| !dep.starts_with("/usr/lib/") && !dep.starts_with("/System/"))
            .map(String::from)
            .collect()
    }

    #[test]
    fn sidecars_are_self_contained() {
        for name in ["ffmpeg", "ffprobe"] {
            let path = sidecar_path(name);
            assert!(
                path.exists(),
                "missing bundled sidecar: {}",
                path.display()
            );

            let deps = non_system_deps(&path);
            assert!(
                deps.is_empty(),
                "sidecar `{name}` is not self-contained — it links against \
                 non-system libraries that will be missing on users' machines: {deps:?}. \
                 Rebuild/replace it with a static binary (only /usr/lib + /System/…).",
            );
        }
    }
}
