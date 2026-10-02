#!/usr/bin/env bash
set -euo pipefail

bundle_id="com.alt-shifted.react-native-calculator"
app="${RUNNER_TEMP:?RUNNER_TEMP must be set}/rustra-ios-dd/Build/Products/Release-iphonesimulator/reactnativecalculator.app"
log_path="$RUNNER_TEMP/rustra-ios-console.log"
native_stdout_path="$RUNNER_TEMP/rustra-ios-native.stdout.log"
native_stderr_path="$RUNNER_TEMP/rustra-ios-native.stderr.log"
kill_error_path="$RUNNER_TEMP/rustra-ios-kill.stderr.log"
process_path="$RUNNER_TEMP/rustra-ios-process.log"
crash_summary_path="$RUNNER_TEMP/rustra-ios-crash-summary.json"
attempts="${RUSTRA_SMOKE_ATTEMPTS:-60}"
delay="${RUSTRA_SMOKE_DELAY_SECONDS:-5}"
if [[ ! "$attempts" =~ ^[1-9][0-9]*$ || ! "$delay" =~ ^[0-9]+$ ]]; then
  echo "::error::smoke attempts must be positive and delay must be non-negative" >&2
  exit 2
fi
test -d "$app" || { echo "::error::app product is missing: $app" >&2; exit 1; }

sim_id="$(xcrun simctl list devices available -j | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const devices = Object.values(JSON.parse(input).devices).flat()
    .filter(device => device.isAvailable && device.name.startsWith("iPhone"));
  const device = devices.find(device => device.state === "Booted") ?? devices[0];
  if (!device) process.exit(1);
  console.log(device.udid);
});
')"
echo "smoke: booting simulator $sim_id"
xcrun simctl boot "$sim_id" 2>/dev/null || true
xcrun simctl bootstatus "$sim_id" -b
echo "smoke: installing $bundle_id"
xcrun simctl install "$sim_id" "$app"
started_at="@$(date +%s)"
native_sim_dir="/tmp/rustra-ios-native-${started_at#@}-$$"
native_sim_stdout_path="$native_sim_dir/rustra-ios-native.stdout.log"
native_sim_stderr_path="$native_sim_dir/rustra-ios-native.stderr.log"
native_host_dir=""
native_launch_args=(--terminate-running-process)
if native_sim_data_dir="$(xcrun simctl getenv "$sim_id" SIMULATOR_SHARED_RESOURCES_DIRECTORY 2>/dev/null)" \
  && [[ -d "$native_sim_data_dir" ]]; then
  native_host_dir="$native_sim_data_dir$native_sim_dir"
  if mkdir -p "$native_host_dir" 2>/dev/null; then
    native_launch_args+=(--stdout="$native_sim_stdout_path" --stderr="$native_sim_stderr_path")
  else
    native_host_dir=""
  fi
fi
cleanup_native_logs() {
  if [[ -n "$native_host_dir" ]]; then
    rm -rf "$native_host_dir" || true
  fi
}
trap cleanup_native_logs EXIT
echo "smoke: launching $bundle_id"
launch_output="$(xcrun simctl launch "${native_launch_args[@]}" "$sim_id" "$bundle_id")"
echo "$launch_output"
app_pid="${launch_output##*: }"
if [[ ! "$app_pid" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::simctl launch did not return a valid app PID" >&2
  exit 1
fi
trap 'xcrun simctl terminate "$sim_id" "$bundle_id" 2>/dev/null || true; cleanup_native_logs' EXIT

copy_native_log() {
  if ! cp "$1" "$2" 2>/dev/null; then
    rm -f "$2" || true
  fi
}

failure_diagnostics() {
  # simctl launch resolves output paths inside this simulator, not on the host.
  if [[ -n "$native_host_dir" ]]; then
    copy_native_log "$native_host_dir/rustra-ios-native.stdout.log" "$native_stdout_path"
    copy_native_log "$native_host_dir/rustra-ios-native.stderr.log" "$native_stderr_path"
  fi
  if [[ -n "$native_host_dir" && -s "$native_stderr_path" ]]; then
    echo "smoke: native stderr for pid=$app_pid (last 80 lines, at most 16384 bytes)" >&2
    tail -c 16384 "$native_stderr_path" | tail -n 80 >&2 || true
  else
    echo "smoke: native stderr is empty or unavailable for pid=$app_pid" >&2
  fi
  if [[ -s "$kill_error_path" ]]; then
    echo "smoke: kill -0 stderr for pid=$app_pid" >&2
    cat "$kill_error_path" >&2 || true
  fi
  echo "smoke: process diagnostic for pid=$app_pid (PID UID STAT COMM)" >&2
  ps -p "$app_pid" -o pid=,uid=,stat=,comm= > "$process_path" 2>&1 || true
  cat "$process_path" >&2 || true

  local helper
  helper="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-ios-crash-summary.mjs"
  if [[ -f "$helper" ]]; then
    rm -f "$crash_summary_path" || true
    if node "$helper" --pid "$app_pid" --started-at "$started_at" \
      --sim-id "$sim_id" --output "$crash_summary_path" >&2; then
      if [[ -f "$crash_summary_path" ]]; then
        cat "$crash_summary_path" >&2 || true
      fi
    else
      echo "smoke: crash summary diagnostic failed; original smoke failure retained" >&2
    fi
  fi
}

# RCTDefaultLogFunction writes os_log, which --console-pty does not capture.
# Scope the persisted log query to this launch's PID and timestamp.
for ((i = 0; i < attempts; i++)); do
  xcrun simctl spawn "$sim_id" log show --style compact --info --debug \
    --start "$started_at" \
    --predicate "(processIdentifier == $app_pid) AND subsystem == \"com.facebook.react.log\" AND category == \"javascript\" AND eventMessage CONTAINS \"__RUSTRA_SMOKE_\"" \
    > "$log_path"
  if grep -Fq '__RUSTRA_SMOKE_FAIL__' "$log_path"; then
    echo "::error::__RUSTRA_SMOKE_FAIL__ observed" >&2
    cat "$log_path" >&2
    failure_diagnostics
    exit 1
  fi
  if ! kill -0 "$app_pid" 2> "$kill_error_path"; then
    echo "::error::app process is not alive: $app_pid" >&2
    cat "$log_path" >&2
    failure_diagnostics
    exit 1
  fi
  if grep -Fq '__RUSTRA_SMOKE_OK__' "$log_path"; then
    echo "smoke OK: pid=$app_pid, __RUSTRA_SMOKE_OK__ observed ($sim_id)"
    exit 0
  fi
  sleep "$delay"
done
echo "::error::__RUSTRA_SMOKE_OK__ was not observed in unified logging" >&2
cat "$log_path" >&2
failure_diagnostics
exit 1
