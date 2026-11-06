#!/usr/bin/env bash
# Join this machine to the pool as a Parallax node (SPEC §3.2 step 3).
# Usage: pool/join-node.sh [env-file]   (default pool/node.env, ROLE=node)
#        DRY_RUN=1 pool/join-node.sh    prints the command only
# Start every node join within 30 s of the others (a slow joiner is dropped at placement).
# Download the model BEFORE joining: nodes run with HF_HUB_OFFLINE=1.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-$POOL_DIR/node.env}"
require PARALLAX_DIR ROLE DHT_PREFIX LAN_IP TCP_PORT UDP_PORT
[ "$ROLE" = "node" ] || die "ROLE must be 'node' in this env file (got '$ROLE')"

export HF_HUB_OFFLINE=1
# CUDA nodes: FlashInfer/deep_gemm JIT needs nvcc from the venv (HANDOFF §2.2).
if [ -n "${CUDA_HOME:-}" ]; then
  [ "${DRY_RUN:-0}" = "1" ] || [ -x "$CUDA_HOME/bin/nvcc" ] || die "no nvcc at $CUDA_HOME/bin/nvcc"
  export CUDA_HOME PATH="$CUDA_HOME/bin:$PATH"
fi
[ "${DRY_RUN:-0}" = "1" ] || use_venv
net_flags

# Mac: EXTRA_FLAGS="--kv-cache-memory-fraction 0.25 --max-sequence-length 4096"
# shellcheck disable=SC2086 # EXTRA_FLAGS is a list of flags: word-split on purpose.
start_group node parallax join "${NET_FLAGS[@]}" ${EXTRA_FLAGS:-}
