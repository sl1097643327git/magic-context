use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use magic_context_dashboard_lib::project_identity::{
    clear_cache_for_tests, logical_absolute, normalize_stored_project_path,
    resolve_project_identity, resolve_project_identity_strict, IdentityErrorClass,
};
use serde::Deserialize;

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn env_lock() -> &'static Mutex<()> {
    ENV_LOCK.get_or_init(|| Mutex::new(()))
}

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn expected_dir_identity(path: &Path) -> String {
    let digest = md5::compute(path.to_string_lossy().as_bytes());
    let hex = format!("{digest:x}");
    format!("dir:{}", &hex[..12])
}

#[cfg(unix)]
fn write_mock_git(script: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::write(script, body).expect("write mock git");
    let mut perms = std::fs::metadata(script)
        .expect("mock git metadata")
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(script, perms).expect("chmod mock git");
}

#[cfg(unix)]
fn with_mock_git_path<T>(bin_dir: &Path, run: impl FnOnce() -> T) -> T {
    let _guard = env_lock().lock().expect("env lock");
    clear_cache_for_tests();

    let old_path = std::env::var_os("PATH");
    let joined = match old_path.as_ref() {
        Some(old) => {
            let mut paths = vec![bin_dir.to_path_buf()];
            paths.extend(std::env::split_paths(old));
            std::env::join_paths(paths).expect("join PATH")
        }
        None => bin_dir.as_os_str().to_os_string(),
    };
    std::env::set_var("PATH", joined);
    let result = run();
    if let Some(old) = old_path {
        std::env::set_var("PATH", old);
    } else {
        std::env::remove_var("PATH");
    }
    clear_cache_for_tests();
    result
}

#[test]
#[cfg(unix)]
fn logical_absolute_matches_node_path_resolve_matrix() {
    let cwd = Path::new("/tmp/cwd/project");
    let cases = [
        ("/foo/bar", "/foo/bar"),
        ("/foo/../bar", "/bar"),
        ("./baz", "/tmp/cwd/project/baz"),
        ("foo/bar", "/tmp/cwd/project/foo/bar"),
        ("/", "/"),
        ("/..", "/"),
        ("../sibling", "/tmp/cwd/sibling"),
        ("foo/./bar//baz/", "/tmp/cwd/project/foo/bar/baz"),
    ];

    for (input, expected) in cases {
        assert_eq!(
            logical_absolute(Path::new(input), cwd),
            PathBuf::from(expected)
        );
    }
}

#[test]
fn resolve_project_identity_on_git_repo_returns_root_commit_hash() {
    let _guard = env_lock().lock().expect("env lock");
    if !git_available() {
        return;
    }

    clear_cache_for_tests();

    let dir = tempfile::tempdir().expect("tempdir");
    assert!(Command::new("git")
        .arg("init")
        .current_dir(dir.path())
        .output()
        .expect("git init")
        .status
        .success());
    std::fs::write(dir.path().join("README.md"), "hello\n").expect("write readme");
    assert!(Command::new("git")
        .args(["add", "README.md"])
        .current_dir(dir.path())
        .output()
        .expect("git add")
        .status
        .success());
    assert!(Command::new("git")
        .args([
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "user.name=Magic Context Test",
            "commit",
            "-m",
            "init",
        ])
        .current_dir(dir.path())
        .output()
        .expect("git commit")
        .status
        .success());

    let expected = String::from_utf8(
        Command::new("git")
            .args(["rev-list", "--max-parents=0", "HEAD"])
            .current_dir(dir.path())
            .output()
            .expect("git rev-list")
            .stdout,
    )
    .expect("utf8")
    .lines()
    .next()
    .expect("root hash")
    .trim()
    .to_string();

    assert_eq!(
        resolve_project_identity(dir.path()),
        format!("git:{expected}")
    );
}

#[test]
fn resolve_project_identity_on_non_git_directory_returns_md5_12_dir_identity() {
    let _guard = env_lock().lock().expect("env lock");
    if !git_available() {
        return;
    }

    clear_cache_for_tests();

    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        resolve_project_identity(dir.path()),
        expected_dir_identity(dir.path())
    );
}

#[test]
fn strict_non_git_directory_returns_not_git_repo() {
    let _guard = env_lock().lock().expect("env lock");
    if !git_available() {
        return;
    }

    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        resolve_project_identity_strict(dir.path()),
        Err(IdentityErrorClass::NotGitRepo)
    );
}

#[test]
fn strict_missing_directory_returns_unknown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("does-not-exist");
    assert_eq!(
        resolve_project_identity_strict(&missing),
        Err(IdentityErrorClass::Unknown)
    );
}

#[test]
#[cfg(unix)]
fn strict_git_probe_times_out_on_slow_git() {
    let bin_dir = tempfile::tempdir().expect("bin dir");
    write_mock_git(
        &bin_dir.path().join("git"),
        "#!/bin/sh\nsleep 10\necho abcdef1234567890\n",
    );
    let cwd = tempfile::tempdir().expect("cwd");

    with_mock_git_path(bin_dir.path(), || {
        let started = std::time::Instant::now();
        let result = resolve_project_identity_strict(cwd.path());
        assert_eq!(result, Err(IdentityErrorClass::GitTimeout));
        assert!(started.elapsed() < std::time::Duration::from_secs(8));
    });
}

#[test]
#[cfg(unix)]
fn strict_git_probe_sets_c_locale_environment() {
    let bin_dir = tempfile::tempdir().expect("bin dir");
    let sha = "abcdef1234567890abcdef1234567890abcdef12";
    write_mock_git(
        &bin_dir.path().join("git"),
        &format!(
            "#!/bin/sh\nif [ \"$LC_ALL\" = C ] && [ \"$LANG\" = C ]; then echo {sha}; exit 0; fi\necho 'not a git repository: locale mismatch' >&2\nexit 1\n"
        ),
    );
    let cwd = tempfile::tempdir().expect("cwd");

    with_mock_git_path(bin_dir.path(), || {
        assert_eq!(
            resolve_project_identity_strict(cwd.path()),
            Ok(format!("git:{sha}"))
        );
    });
}

#[test]
#[cfg(unix)]
fn normalize_stored_project_path_short_circuits_identities_without_spawning_git() {
    let bin_dir = tempfile::tempdir().expect("bin dir");
    let marker = bin_dir.path().join("spawned");
    write_mock_git(
        &bin_dir.path().join("git"),
        &format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display()),
    );

    with_mock_git_path(bin_dir.path(), || {
        assert_eq!(normalize_stored_project_path("git:abc123"), "git:abc123");
        assert_eq!(
            normalize_stored_project_path("dir:deadbeef0000"),
            "dir:deadbeef0000"
        );
        assert!(
            !marker.exists(),
            "git mock should not be invoked for stored identities"
        );
    });
}

#[test]
#[cfg(unix)]
fn normalize_stored_project_path_resolves_raw_paths() {
    let bin_dir = tempfile::tempdir().expect("bin dir");
    let sha = "1234567890abcdef1234567890abcdef12345678";
    write_mock_git(
        &bin_dir.path().join("git"),
        &format!("#!/bin/sh\necho {sha}\n"),
    );
    let cwd = tempfile::tempdir().expect("cwd");

    with_mock_git_path(bin_dir.path(), || {
        assert_eq!(
            normalize_stored_project_path(cwd.path().to_str().expect("utf8 tempdir")),
            format!("git:{sha}")
        );
    });
}

#[derive(Deserialize)]
struct ParityFixture {
    input: String,
    resolved: String,
    identity: String,
}

#[test]
#[cfg(unix)]
fn cross_language_identity_parity_fixture_matches_ts_contract() {
    // Fixture outputs are generated from the TypeScript production contract:
    // path.resolve(input), then createHash("md5").update(resolved).digest("hex").slice(0, 12)
    // for non-git directories. When Worker B lands shared TS fixtures, this file can be
    // replaced with their canonical JSON without changing the Rust assertion shape.
    let cases: Vec<ParityFixture> =
        serde_json::from_str(include_str!("fixtures/project_identity_parity.json"))
            .expect("parse parity fixture");

    let _guard = env_lock().lock().expect("env lock");
    clear_cache_for_tests();

    for case in cases {
        std::fs::create_dir_all(&case.resolved).expect("create fixture dir");
        assert_eq!(
            logical_absolute(Path::new(&case.input), Path::new("/ignored")),
            PathBuf::from(&case.resolved)
        );
        assert_eq!(resolve_project_identity(&case.input), case.identity);
    }
}
