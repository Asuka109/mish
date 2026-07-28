#!/bin/bash

set -euo pipefail

mode="${1:-}"
runner_root="${MISH_RUNNER_ROOT:-}"
hook_root="${MISH_RUNNER_HOOK_ROOT:-}"

fail() {
  echo "mish runner hygiene failed: $1" >&2
  exit 1
}

[[ "$mode" == "started" || "$mode" == "completed" ]] ||
  fail "expected started or completed"
[[ "$(id -u)" -ne 0 ]] || fail "runner must not execute as root"
[[ "$(uname -m)" == "arm64" ]] || fail "runner is not Apple Silicon"
[[ -n "$runner_root" && "$runner_root" == "$HOME/actions-runner/mish" ]] ||
  fail "runner root is not the registered Mish directory"
[[ -n "$hook_root" && "$hook_root" == "$HOME/.local/share/mish-runner-hooks" ]] ||
  fail "hook root is not outside the runner application directory"
[[ -d "$runner_root" && -d "$hook_root" ]] || fail "runner or hook directory is missing"
[[ "$(/usr/bin/stat -f '%u' "$runner_root")" == "$(id -u)" ]] ||
  fail "runner root is not owned by the service account"

state_root="$HOME/.local/state/mish-runner"
work_root="$runner_root/_work"
/bin/mkdir -p "$state_root" "$work_root"
/bin/chmod 700 "$state_root" "$work_root"

is_hook_ancestor() {
  local candidate="$1"
  local current="$$"

  while [[ "$current" =~ ^[0-9]+$ && "$current" -gt 1 ]]; do
    [[ "$current" == "$candidate" ]] && return 0
    current="$(/bin/ps -p "$current" -o ppid= 2>/dev/null | /usr/bin/xargs || true)"
  done
  return 1
}

pid_has_runner_cwd() {
  local pid="$1"
  local cwd
  cwd="$(
    /usr/sbin/lsof -n -a -p "$pid" -d cwd -Fn 2>/dev/null |
      /usr/bin/awk '/^n/ { sub(/^n/, ""); print; exit }'
  )"
  [[ "$cwd" == "$work_root" || "$cwd" == "$work_root"/* ]]
}

stop_workspace_processes() {
  local current_pid=""
  local line
  local pid
  local pids_file="$state_root/workspace-pids.$$"

  : >"$pids_file"
  while IFS= read -r line; do
    case "$line" in
      p*)
        current_pid="${line#p}"
        ;;
      n"$work_root"|n"$work_root"/*)
        if [[ "$current_pid" =~ ^[0-9]+$ ]] && ! is_hook_ancestor "$current_pid"; then
          printf '%s\n' "$current_pid" >>"$pids_file"
        fi
        ;;
    esac
  done < <(/usr/sbin/lsof -n -a -u "$(id -u)" -d cwd -Fp -Fn 2>/dev/null || true)

  /usr/bin/sort -u "$pids_file" -o "$pids_file"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if pid_has_runner_cwd "$pid"; then
      /bin/kill -TERM "$pid" 2>/dev/null || true
    fi
  done <"$pids_file"

  /bin/sleep 1
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if pid_has_runner_cwd "$pid"; then
      /bin/kill -KILL "$pid" 2>/dev/null || true
    fi
  done <"$pids_file"

  /usr/bin/find "$pids_file" -depth -delete 2>/dev/null || true
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
      "$work_root"/*|"$HOME/Library/Keychains/mish-runner-"*)
        /usr/bin/security lock-keychain "$keychain" >/dev/null 2>&1 || true
        /usr/bin/security delete-keychain "$keychain" >/dev/null 2>&1 || true
        ;;
    esac
  done < <(/usr/bin/security list-keychains -d user | /usr/bin/tr -d '\t')
}

clear_workspace() {
  local directory
  [[ "$work_root" == "$HOME/actions-runner/mish/_work" ]] ||
    fail "refusing to clear an unexpected workspace"

  for directory in "$work_root/mish" "$work_root/_actions" "$work_root/_temp"; do
    /bin/mkdir -p "$directory"
    /usr/bin/find "$directory" -depth -mindepth 1 -delete
  done
}

cleanup() {
  stop_workspace_processes
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
