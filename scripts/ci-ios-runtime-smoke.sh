#!/usr/bin/env bash
set -euo pipefail

bundle_id="com.alt-shifted.react-native-calculator"
app="${RUNNER_TEMP:?RUNNER_TEMP must be set}/rustra-ios-dd/Build/Products/Release-iphonesimulator/reactnativecalculator.app"
log_path="$RUNNER_TEMP/rustra-ios-console.log"
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
echo "smoke: launching $bundle_id"
launch_output="$(xcrun simctl launch --terminate-running-process "$sim_id" "$bundle_id")"
echo "$launch_output"
app_pid="${launch_output##*: }"
if [[ ! "$app_pid" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::simctl launch did not return a valid app PID" >&2
  exit 1
fi
trap 'xcrun simctl terminate "$sim_id" "$bundle_id" 2>/dev/null || true' EXIT

# RCTDefaultLogFunction writes os_log, which --console-pty does not capture.
# Scope the persisted log query to this launch's PID and timestamp.
for ((i = 0; i < attempts; i++)); do
  xcrun simctl spawn "$sim_id" log show --style compact --info --debug \
    --start "$started_at" --process "$app_pid" \
    --predicate 'subsystem == "com.facebook.react.log" AND category == "javascript" AND eventMessage CONTAINS "__RUSTRA_SMOKE_"' \
    > "$log_path"
  if grep -Fq '__RUSTRA_SMOKE_FAIL__' "$log_path"; then
    echo "::error::__RUSTRA_SMOKE_FAIL__ observed" >&2
    cat "$log_path" >&2
    exit 1
  fi
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "::error::app process is not alive: $app_pid" >&2
    cat "$log_path" >&2
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
exit 1
