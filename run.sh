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
    exec "$runtime" "$root/calculate.mjs" "$@"
    ;;
  node)
    exec "$runtime" \
      --max-inlined-bytecode-size=1000 \
      --max-inlined-bytecode-size-cumulative=4000 \
      "$root/plain/calculate.mjs" "$@"
    ;;
  *)
    printf '%s\n' 'ENGINE must be node or wasm' >&2
    exit 2
    ;;
esac
