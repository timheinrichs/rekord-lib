//! Guard for the bundled `ffmpeg`/`ffprobe` sidecars.
//!
//! The sidecars in `binaries/` must be **self-contained**: linked only against
//! system libraries (`/usr/lib`, `/System/…`). A Homebrew-built binary links
//! against `/opt/homebrew/…` dylibs that only exist on the build machine, so it
//! crashes with `dyld: Library not loaded` on any device without an identical
//! Homebrew install — analysis and conversion then fail silently for users.
//!
//! This module holds no runtime code; it exists purely for the test below, which
//! runs in CI (`cargo test` on the macOS runner) and fails the build if a
//! non-self-contained sidecar ever gets committed again.

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
