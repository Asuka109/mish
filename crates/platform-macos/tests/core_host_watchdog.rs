#![cfg(unix)]

use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[test]
fn watchdog_stops_the_core_after_the_service_parent_exits() {
    let mut core = Command::new("/bin/sh")
        .args(["-c", "trap '' TERM; while :; do /bin/sleep 0.1; done"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let core_pid = core.id();
    let helper = env!("CARGO_BIN_EXE_mish-tun-helper");
    let parent = Command::new("/bin/sh")
        .args([
            "-c",
            "\"$1\" --watch-parent \"$$\" \"$2\" & /bin/sleep 0.3",
            "watchdog-parent",
            helper,
            &core_pid.to_string(),
        ])
        .status()
        .unwrap();
    assert!(parent.success());

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if core.try_wait().unwrap().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = core.kill();
    let _ = core.wait();
    panic!("Core remained alive after the helper parent exited");
}
