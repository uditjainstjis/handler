#!/bin/sh
# Runs a command and records its exit code where anyone can find it.
#
# Only the process that spawned a child receives its 'exit' event. HANDLER's
# runs are detached precisely so they outlive whoever started them — which
# means the exit code is routinely lost, and a finished run sits marked
# `running` forever.
#
# So the outcome goes to a file instead of an event. Any HANDLER process that
# starts later can reconcile from it.
#
# Usage: run-with-exitcode.sh <exitcode-file> <command> [args...]
# "$@" is used throughout, so arguments containing spaces survive intact.

set -u
codefile="$1"
shift

"$@"
status=$?

printf '%s' "$status" > "$codefile"
exit "$status"
