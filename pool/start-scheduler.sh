#!/usr/bin/env bash
# Start the Parallax scheduler on the coordinator (SPEC §3.2 step 2).
# Usage: pool/start-scheduler.sh [env-file]   (default pool/scheduler.env, ROLE=scheduler)
#        DRY_RUN=1 pool/start-scheduler.sh    prints the command only
# The scheduler HTTP API binds 127.0.0.1:3001. Only the gateway calls it.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

load_env "${1:-$POOL_DIR/scheduler.env}"
require PARALLAX_DIR ROLE MODEL INIT_NODES DHT_PREFIX LAN_IP TCP_PORT UDP_PORT
[ "$ROLE" = "scheduler" ] || die "ROLE must be 'scheduler' in this env file (got '$ROLE')"

# The scheduler downloads small model config files: never HF_HUB_OFFLINE here (HANDOFF §2.2).
unset HF_HUB_OFFLINE
[ "${DRY_RUN:-0}" = "1" ] || use_venv
net_flags

# shellcheck disable=SC2086 # EXTRA_FLAGS is a list of flags: word-split on purpose.
start_group scheduler parallax run -m "$MODEL" -n "$INIT_NODES" "${NET_FLAGS[@]}" ${EXTRA_FLAGS:-}
