use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use wait_timeout::ChildExt;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);

static IDENTITY_CACHE: OnceLock<RwLock<HashMap<PathBuf, String>>> = OnceLock::new();

fn cache() -> &'static RwLock<HashMap<PathBuf, String>> {
    IDENTITY_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Lexically resolve `input` against `cwd`, matching Node's `path.resolve` semantics.
///
/// This intentionally does not touch the filesystem: no symlink resolution, no
/// existence checks, and no `std::fs::canonicalize`. The dashboard MSRV is 1.77,
/// so this also avoids `std::path::absolute` (stabilized in 1.79).
pub fn logical_absolute(input: &Path, cwd: &Path) -> PathBuf {
    let mut base = if input.is_absolute() {
        PathBuf::new()
    } else {
        cwd.to_path_buf()
    };

    for component in input.components() {
        match component {
            Component::Prefix(prefix) => {
                base = PathBuf::from(prefix.as_os_str());
            }
            Component::RootDir => {
                // Reset to root while preserving a Windows drive/UNC prefix when present.
                let prefix = base.components().find_map(|component| match component {
                    Component::Prefix(prefix) => Some(prefix.as_os_str().to_os_string()),
                    _ => None,
                });
                base = match prefix {
                    Some(prefix) => {
                        let mut path = PathBuf::from(prefix);
                        path.push("/");
                        path
                    }
                    None => PathBuf::from("/"),
                };
            }
            Component::CurDir => {}
            Component::ParentDir => {
                // Match Node path.resolve("/..") === "/": only pop a normal path segment.
                let last = base.components().next_back();
                if matches!(last, Some(Component::Normal(_))) {
                    base.pop();
                }
            }
            Component::Normal(segment) => {
                base.push(segment);
            }
        }
    }

    base
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityErrorClass {
    NotGitRepo,
    GitMissing,
    GitTimeout,
    PermissionDenied,
    Unknown,
}

pub fn resolve_project_identity_strict(directory: &Path) -> Result<String, IdentityErrorClass> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let canonical = logical_absolute(directory, &cwd);

    // If the cwd itself is missing, the git spawn would also return NotFound; distinguish
    // that from a missing git binary before classifying the spawn error.
    if !canonical.exists() {
        return Err(IdentityErrorClass::Unknown);
    }

    let mut child = Command::new("git")
        .args(["rev-list", "--max-parents=0", "HEAD"])
        .current_dir(&canonical)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => IdentityErrorClass::GitMissing,
            std::io::ErrorKind::PermissionDenied => IdentityErrorClass::PermissionDenied,
            _ => IdentityErrorClass::Unknown,
        })?;

    let status = match child
        .wait_timeout(GIT_TIMEOUT)
        .map_err(|_| IdentityErrorClass::Unknown)?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(IdentityErrorClass::GitTimeout);
        }
    };

    let output = child
        .wait_with_output()
        .map_err(|_| IdentityErrorClass::Unknown)?;

    if status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first_line = stdout.lines().next().unwrap_or("").trim();
        if first_line.len() < 7 {
            return Err(IdentityErrorClass::Unknown);
        }
        // TS accepts the complete root hash line. SHA-1 repos produce 40 chars;
        // SHA-256 repos produce 64. Cap at 64 to avoid accepting accidental noise.
        let sha = first_line.chars().take(64).collect::<String>();
        return Ok(format!("git:{sha}"));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("not a git repository") {
        Err(IdentityErrorClass::NotGitRepo)
    } else if stderr.contains("permission denied") {
        Err(IdentityErrorClass::PermissionDenied)
    } else {
        Err(IdentityErrorClass::Unknown)
    }
}

/// Resolve a raw filesystem path to the stable project identity used by the TS plugin.
///
/// Mirrors `packages/plugin/src/features/magic-context/memory/project-identity.ts`:
/// logical absolute path resolution, `git rev-list --max-parents=0 HEAD`, and
/// `dir:<md5-12>` fallback over the resolved UTF-8 path bytes.
pub fn resolve_project_identity<P: AsRef<Path>>(directory: P) -> String {
    let directory = directory.as_ref();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let canonical = logical_absolute(directory, &cwd);

    if let Ok(cache) = cache().read() {
        if let Some(identity) = cache.get(&canonical) {
            return identity.clone();
        }
    }

    let identity = match resolve_project_identity_strict(&canonical) {
        Ok(identity) => identity,
        Err(IdentityErrorClass::NotGitRepo) => directory_fallback(&canonical),
        Err(error) => {
            eprintln!(
                "[dashboard] resolve_project_identity error {:?} on {:?}",
                error, canonical
            );
            directory_fallback(&canonical)
        }
    };

    if let Ok(mut cache) = cache().write() {
        cache.insert(canonical, identity.clone());
    }

    identity
}

fn directory_fallback(path: &Path) -> String {
    let digest = md5::compute(path.to_string_lossy().as_bytes());
    let hex = format!("{digest:x}");
    format!("dir:{}", &hex[..12])
}

/// Normalize a value read from `memories.project_path` / related stored identity columns.
///
/// Stored DB values may already be identities (`git:*`, `dir:*`). Those must be returned
/// unchanged; passing them through `resolve_project_identity` would hash the identity text as
/// a filesystem path and corrupt the project_state key.
pub fn normalize_stored_project_path(raw_or_stored: &str) -> String {
    if raw_or_stored.starts_with("git:") || raw_or_stored.starts_with("dir:") {
        return raw_or_stored.to_string();
    }
    resolve_project_identity(Path::new(raw_or_stored))
}

pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string())
}

#[doc(hidden)]
pub fn clear_cache_for_tests() {
    if let Ok(mut cache) = cache().write() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_current_repo_as_git_identity() {
        clear_cache_for_tests();
        let identity = resolve_project_identity(".");
        assert!(identity.starts_with("git:"), "{identity}");
        assert!(identity.len() > 11);
    }

    #[test]
    fn non_git_directory_uses_md5_dir_identity() {
        clear_cache_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let identity = resolve_project_identity(dir.path());
        assert!(identity.starts_with("dir:"), "{identity}");
        assert_eq!(identity.len(), 16);
    }
}
