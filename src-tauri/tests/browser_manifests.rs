//! Regression tests for the two macOS bugs that made KeePassXC-Browser unable
//! to connect at all:
//!
//! 1. the native-messaging manifests were only written to the Linux locations,
//!    so Firefox never found the host;
//! 2. the socket directory helper chmod'ed the *parent of the socket*, which on
//!    macOS (no `XDG_RUNTIME_DIR`) was `/tmp` — the chmod failed with EPERM and
//!    took the whole bridge down with it.
//!
//! Both are asserted through the same functions the app uses at startup.

#![cfg(unix)]

use std::path::Path;

use keeweb_next_lib::browser_bridge::{manifest_targets, HOST_NAME};
use keeweb_next_lib::browser_socket;

#[test]
fn every_target_uses_the_platform_manifest_location() {
    let home = Path::new("/Users/tester");
    let targets = manifest_targets(home);
    assert!(!targets.is_empty());

    #[cfg(target_os = "macos")]
    {
        // macOS keeps every browser under Library/Application Support, Firefox
        // included; the Linux layout must not be used at all.
        for target in &targets {
            let path = target.dir.to_string_lossy();
            assert!(
                path.starts_with("/Users/tester/Library/Application Support/"),
                "unexpected manifest dir on macOS: {}",
                target.dir.display()
            );
            assert!(
                !path.contains("/.config/") && !path.contains("/.mozilla/"),
                "linux manifest path used on macOS: {}",
                target.dir.display()
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        for target in &targets {
            let path = target.dir.to_string_lossy();
            assert!(
                path.starts_with("/Users/tester/.config/")
                    || path.starts_with("/Users/tester/.mozilla/"),
                "unexpected manifest dir: {}",
                target.dir.display()
            );
        }
    }
}

#[test]
fn the_firefox_target_matches_what_the_extension_looks_for() {
    let targets = manifest_targets(Path::new("/Users/tester"));
    let firefox: Vec<_> = targets.iter().filter(|t| t.firefox).collect();
    assert_eq!(firefox.len(), 1, "expected exactly one firefox target");
    assert_eq!(
        firefox[0].dir.file_name().unwrap(),
        std::ffi::OsStr::new("NativeMessagingHosts"),
        "firefox manifest dir must be NativeMessagingHosts on macOS",
    );

    #[cfg(target_os = "macos")]
    assert_eq!(
        firefox[0].dir,
        Path::new("/Users/tester/Library/Application Support/Mozilla/NativeMessagingHosts"),
    );
    #[cfg(not(target_os = "macos"))]
    assert_eq!(
        firefox[0].dir,
        Path::new("/Users/tester/.mozilla/native-messaging-hosts"),
    );
}

#[test]
fn the_firefox_manifest_is_written_even_before_mozilla_dir_exists() {
    // Firefox never creates ~/Library/Application Support/Mozilla on its own,
    // so gating on that directory would skip the install forever. The marker
    // has to be something else (Firefox.app on macOS).
    let home = Path::new("/Users/tester");
    let firefox = manifest_targets(home)
        .into_iter()
        .find(|t| t.firefox)
        .expect("firefox target");
    assert!(
        !firefox.dir.exists(),
        "precondition: the manifest dir should not exist in this fixture"
    );
    // On this machine Firefox is installed, so the target must be enabled.
    #[cfg(target_os = "macos")]
    if Path::new("/Applications/Firefox.app").exists() {
        assert!(
            firefox.installed,
            "firefox installed but the manifest target is disabled"
        );
    }
}

#[test]
fn the_socket_never_lives_in_a_shared_directory() {
    // The bug: the socket was placed straight in $TMPDIR (/tmp), and preparing
    // it chmod'ed that shared directory to 0700 — impossible for a normal user,
    // fatal for the bridge.
    if std::env::var_os("KEEWEB_BROWSER_SOCKET").is_some()
        || std::env::var_os("XDG_RUNTIME_DIR").is_some()
    {
        return; // overridden environment, nothing to assert about defaults
    }

    let path = browser_socket::socket_path();
    let dir = path.parent().expect("socket has a parent");

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").expect("HOME");
        assert_eq!(
            dir,
            Path::new(&home).join("Library/Application Support/KeeWeb Next/browser"),
        );
    }

    assert_ne!(dir, std::env::temp_dir(), "socket must not sit in the temp dir");
    assert_ne!(dir, Path::new("/tmp"), "socket must not sit in /tmp");
    assert!(
        dir.components().count() > 2,
        "socket directory must be private to the app: {}",
        dir.display()
    );
}

#[test]
fn preparing_the_socket_directory_is_idempotent() {
    use std::os::unix::fs::PermissionsExt;

    let base = std::env::temp_dir().join(format!("kw-socket-test-{}", std::process::id()));
    let socket = base.join("nested").join("browser.sock");

    browser_socket::prepare_dir(&socket).expect("first prepare");
    browser_socket::prepare_dir(&socket).expect("second prepare is a no-op");

    let mode = std::fs::metadata(socket.parent().unwrap()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "socket directory must be private");

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn the_host_name_is_the_one_keepassxc_browser_connects_to() {
    // hardcoded in the extension, cannot be changed on our side
    assert_eq!(HOST_NAME, "org.keepassxc.keepassxc_browser");
}

#[test]
fn installing_then_disabling_round_trips_the_manifest() {
    // Exercises the settings toggle against a throwaway home, so the real
    // ~/Library manifest is never touched.
    use keeweb_next_lib::browser_bridge::{install_manifests_in, remove_manifests_in};

    let home = std::env::temp_dir().join(format!("kw-manifest-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();

    // host_binary_path() resolves the helper next to current_exe, which under
    // `cargo test` is the test harness itself; pin it instead.
    let fake_host = home.join("keeweb-next-browser-host");
    std::fs::write(&fake_host, b"#!/bin/sh\n").unwrap();
    std::env::set_var("KEEWEB_NATIVE_HOST", &fake_host);

    install_manifests_in(&home);
    let manifest = manifest_targets(&home)
        .into_iter()
        .find(|t| t.firefox)
        .map(|t| t.dir.join(format!("{}.json", HOST_NAME)))
        .unwrap();

    let body = std::fs::read_to_string(&manifest).unwrap_or_else(|e| {
        panic!(
            "firefox manifest was not installed at {}: {}",
            manifest.display(),
            e
        )
    });
    let parsed: serde_json::Value = serde_json::from_str(&body).expect("manifest is valid json");
    assert_eq!(parsed["name"], HOST_NAME);
    assert_eq!(parsed["type"], "stdio");
    assert_eq!(parsed["allowed_extensions"][0], "keepassxc-browser@keepassxc.org");
    let host = parsed["path"].as_str().unwrap();
    assert!(
        Path::new(host).is_absolute() && Path::new(host).is_file(),
        "manifest points at a host binary that does not exist: {}",
        host
    );

    remove_manifests_in(&home);
    assert!(
        !manifest.exists(),
        "disabling the integration must remove the manifest"
    );

    let _ = std::fs::remove_dir_all(&home);
}
