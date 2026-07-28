#!/bin/bash

set -euo pipefail

mode="${1:-}"
expected_user="${MISH_RUNNER_USER:-mish-ci}"
runner_root="${MISH_RUNNER_ROOT:-}"
hook_root="${MISH_RUNNER_HOOK_ROOT:-}"

fail() {
  echo "mish runner hygiene failed: $1" >&2
  exit 1
}

[[ "$mode" == "started" || "$mode" == "completed" ]] ||
  fail "expected started or completed"
[[ "$(id -un)" == "$expected_user" ]] || fail "unexpected service account"
[[ "$(uname -m)" == "arm64" ]] || fail "runner is not Apple Silicon"
[[ -n "$runner_root" && "$runner_root" == "$HOME/actions-runner" ]] ||
  fail "runner root is not the dedicated account directory"
[[ -n "$hook_root" && "$hook_root" == "$HOME/.local/share/mish-runner-hooks" ]] ||
  fail "hook root is not outside the runner application directory"
[[ -d "$runner_root" && -d "$hook_root" ]] || fail "runner or hook directory is missing"

console_user="$(/usr/bin/stat -f '%Su' /dev/console)"
[[ "$console_user" != "$expected_user" ]] ||
  fail "the runner account is the active interactive desktop"

state_root="$HOME/.local/state/mish-runner"
work_root="$runner_root/_work"
/bin/mkdir -p "$state_root" "$work_root"
/bin/chmod 700 "$state_root" "$work_root"

stop_processes() {
  local uid_value process_name
  uid_value="$(id -u)"
  for process_name in \
    Mish mihomo mish-bridge mish-core-host mish-tun-helper tauri-driver \
    node cargo rustc java gradle Chromium chrome_crashpad_handler; do
    /usr/bin/pkill -TERM -u "$uid_value" -x "$process_name" 2>/dev/null || true
  done
  /bin/sleep 1
  for process_name in \
    Mish mihomo mish-bridge mish-core-host mish-tun-helper tauri-driver \
    node cargo rustc java gradle Chromium chrome_crashpad_handler; do
    /usr/bin/pkill -KILL -u "$uid_value" -x "$process_name" 2>/dev/null || true
  done
}

detach_runner_images() {
  local image_path mountpoint
  while IFS=$'\t' read -r image_path mountpoint; do
    [[ -n "$image_path" && -n "$mountpoint" ]] || continue
    case "$image_path" in
      "$work_root"/*)
        detached=false
        for _attempt in 1 2 3 4 5; do
          if /usr/bin/hdiutil detach "$mountpoint" >/dev/null 2>&1; then
            detached=true
            break
          fi
          /bin/sleep 1
        done
        [[ "$detached" == true ]] || fail "a runner-owned disk image could not be detached"
        ;;
    esac
  done < <(
    /usr/bin/hdiutil info |
      /usr/bin/awk -F '\t' '
        /^image-path[[:space:]]*:/ {
          image = $0
          sub(/^image-path[[:space:]]*:[[:space:]]*/, "", image)
        }
        /^\/dev\// && NF > 1 && $NF ~ /^\// {
          print image "\t" $NF
        }
      '
  )
}

delete_runner_keychains() {
  local keychain
  while IFS= read -r keychain; do
    keychain="${keychain#\"}"
    keychain="${keychain%\"}"
    case "$keychain" in
      "$work_root"/*|"$HOME/Library/Keychains/mish-ci-"*)
        /usr/bin/security lock-keychain "$keychain" >/dev/null 2>&1 || true
        /usr/bin/security delete-keychain "$keychain" >/dev/null 2>&1 || true
        ;;
    esac
  done < <(/usr/bin/security list-keychains -d user | /usr/bin/tr -d '\t')
}

clear_workspace() {
  [[ "$work_root" == "$HOME/actions-runner/_work" ]] ||
    fail "refusing to clear an unexpected workspace"
  /usr/bin/find "$work_root" -depth -mindepth 1 -delete
}

cleanup() {
  stop_processes
  detach_runner_images
  delete_runner_keychains
  clear_workspace
}

lock_directory="$state_root/job.lock"
if [[ "$mode" == "started" ]]; then
  cleanup
  /usr/bin/find "$lock_directory" -depth -delete 2>/dev/null || true
  /bin/mkdir -m 700 "$lock_directory"
  /usr/bin/touch "$lock_directory/${GITHUB_RUN_ID:-unknown}-${GITHUB_RUN_ATTEMPT:-unknown}"
  echo "mish runner hygiene: pre-job cleanup passed"
else
  cleanup
  /usr/bin/find "$lock_directory" -depth -delete 2>/dev/null || true
  echo "mish runner hygiene: post-job cleanup passed"
fi
