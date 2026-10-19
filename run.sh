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

exec "$runtime" "$root/calculate.mjs" "$@"
