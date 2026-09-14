#!/usr/bin/env bash
# Keep the tested command's failure visible even when its output is piped to tee.
set -u
set -o pipefail
label=${1:?usage: run-safety-check.sh LABEL COMMAND...}
shift
if [[ ! "$label" =~ ^[a-zA-Z0-9_-]+$ ]] || (( $# == 0 )); then
  echo 'expected a simple label and a command' >&2
  exit 2
fi
log_dir=${SAFETY_LOG_DIR:?SAFETY_LOG_DIR must be an absolute directory}
if [[ "$log_dir" != /* ]]; then
  echo 'SAFETY_LOG_DIR must be absolute' >&2
  exit 2
fi
mkdir -p "$log_dir" || exit 1
"$@" 2>&1 | tee "$log_dir/$label.log"
statuses=("${PIPESTATUS[@]}")
result=${statuses[0]}
printf '%s\n' "$result" > "$log_dir/$label.exit-code" || exit 1
# A failed logger must not turn a successful command into a missing receipt.
if (( result == 0 && statuses[1] != 0 )); then result=${statuses[1]}; fi
exit "$result"
