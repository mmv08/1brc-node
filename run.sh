#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
local_node="$root/.runtimes/node-v26.12.0/bin/node"

if [ -n "${NODE_BIN:-}" ]; then
  runtime=$NODE_BIN
elif [ -x "$local_node" ]; then
  runtime=$local_node
else
  runtime=node
fi

case "${ENGINE:-wasm}" in
  wasm)
    set -- "$root/calculate.mjs" "$@"
    ;;
  node)
    # Each worker compiles its parser once, synchronously and without Maglev,
    # instead of queueing every isolate's compilations on the shared pool.
    set -- \
      --max-inlined-bytecode-size=1000 \
      --max-inlined-bytecode-size-cumulative=4000 \
      --v8-pool-size=8 \
      --no-maglev \
      --no-concurrent-recompilation \
      "$root/plain/calculate.mjs" "$@"
    ;;
  *)
    printf '%s\n' 'ENGINE must be node or wasm' >&2
    exit 2
    ;;
esac

# Linux grows a threaded process's descriptor table behind an RCU grace period
# that stalls every thread opening a descriptor, and each worker opens several.
# A high descriptor held across exec sizes the table before any thread exists.
# Dash cannot name it, so use Bash when present; failure only loses the gain.
if command -v bash >/dev/null 2>&1; then
  exec bash -c '{ exec 1023</dev/null; } 2>/dev/null; exec "$@"' bash "$runtime" "$@"
fi
exec "$runtime" "$@"
