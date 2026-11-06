# pool (C1: Parallax pool runner)

Spec: `docs/SPEC.md` §3. Known-good commands and quirks: `docs/HANDOFF.md` §2.2 and §3.1.
Bash; works on Linux and macOS. Parallax is an installed dependency (`$PARALLAX_DIR`), never forked here.

| Script | What it does |
|---|---|
| `start-scheduler.sh [env]` | `parallax run -m $MODEL -n $INIT_NODES` (default env `pool/scheduler.env`, `ROLE=scheduler`). No `HF_HUB_OFFLINE` (the scheduler downloads small config files). |
| `join-node.sh [env]` | `parallax join` (default env `pool/node.env`, `ROLE=node`). Sets `HF_HUB_OFFLINE=1`; `CUDA_HOME` + `PATH` on CUDA nodes; `$EXTRA_FLAGS` (Mac memory flags). |
| `stop-all.sh` | TERM → KILL each recorded process group, then sweeps every `parallax/.venv/bin/(python\|vllm-rs)` process (`spawn_main`, `resource_tracker`, ghosts). Fails if `pgrep -f "parallax/.venv/bin/python"` is not empty. |
| `status.sh` | `GET http://127.0.0.1:3001/cluster/status_json` (override `PARALLAX_API`). |
| `warmup.sh` | One warm-up request (SPEC §3.2 step 5): no logprobs, `enable_thinking: false`. |

Every start uses `-u`, `--dht-prefix`, fixed `--tcp-port/--udp-port`, and
`--announce-maddrs /ip4/$LAN_IP/tcp/$TCP_PORT /ip4/$LAN_IP/udp/$UDP_PORT/quic-v1`.
Processes start in a new session (`setsid`; on macOS `POSIX::setsid` via perl, because macOS has no `setsid(1)`),
in `cd $PARALLAX_DIR` (the scheduler's `p2p.key` lives there; delete it for a new peer ID).
Logs: `pool/logs/<name>.log`. Process group IDs: `pool/run/<name>.pgid` (both git-ignored).

`DRY_RUN=1 <script>` prints the command and changes nothing.

## Start procedure (SPEC §3.2)

```bash
pool/stop-all.sh                      # on every machine
pool/start-scheduler.sh               # coordinator
pool/join-node.sh                     # every node, ALL within 30 s of each other
pool/status.sh                        # wait until all nodes are ready
pool/warmup.sh
```

Download the model on each node **before** joining (nodes are offline: `HF_HUB_OFFLINE=1`).

Note: `/cluster/status_json` (Parallax `162354a`) lists `node_id` (libp2p peer ID), `status`, `gpu_name`,
`gpu_memory` per node, but **no layer ranges**. See HANDOFF §9.
