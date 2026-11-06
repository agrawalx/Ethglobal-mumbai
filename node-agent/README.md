# node-agent (C2, Python 3.12, uv)

Node key, registration link, heartbeat to the gateway, Arkiv `gpupool.node` listing (extend every 30 s),
coordinator `gpupool.pool` listing, start/stop. Spec: `docs/SPEC.md` §4, §5.5, §11.

```bash
cd node-agent && cp .env.example .env && uv sync
uv run gpupool-node init                 # create NODE_KEY_PATH if missing (0x hex + newline, mode 600); print the registration link
uv run gpupool-node start                # pool/join-node.sh, then heartbeat + Arkiv loop (foreground)
uv run gpupool-node start --no-join      # Parallax node already runs
uv run gpupool-node stop                 # stop the agent + pool/stop-all.sh, set the listing offline
uv run gpupool-node stop --keep-parallax # stop only the agent
uv run pytest -q                         # signatures, body shape, key file, log parsing
uv run python tests/make_vector.py       # rewrite the cross-language vector (gateway/test/cross-language.test.ts checks it)
```

Needs `node` (Node 24) and `pnpm install` at the repo root: Arkiv writes go through `arkiv/src/cli.ts`.

| What | How |
|---|---|
| Registration link | `<FRONTEND_URL>/register-node?node_id&pool_id&gpu&mem_gb&ts&node_sig`; `node_sig` = EIP-191 over `gpupool-register:<node_id>:<pool_id>:<ts>`. The frontend posts the fields to `POST /nodes/register` with the session. Valid 24 h. |
| Heartbeat | Every `HEARTBEAT_SECONDS`: `NodeHeartbeat` JSON, header `x-gpupool-node-signature` = EIP-191 over the exact body bytes. The response gives `owner_account` + `reliability` for the listing. |
| Layer range | From the Parallax node log `PARALLAX_NODE_LOG` (Parallax is not modified; `/cluster/status_json` has no ranges). Last of: `Join scheduler response: {… 'start_layer': S, 'end_layer': E …}` (`p2p/server.py:537`), `Layer allocation changed! … New: [S, E)` (`p2p/server.py:794`), `Reloading executor with layers [S, E)` (`launch.py:293`). ANSI codes stripped. |
| Status | `online` = a `parallax join` process runs and a range is known; `loading` = runs, no range; `offline` = not running. |
| GPU / memory | `nvidia-smi`; macOS: `sysctl machdep.cpu.brand_string` + `hw.memsize`; else CPU + RAM. |
| Arkiv | Every `ARKIV_EXTEND_SECONDS`: `upsert-node` (create, then patch + extend in one tx) signed by the **node key** (`ARKIV_KEY_PATH` = `NODE_KEY_PATH`; `ARKIV_PRIVATE_KEY` is removed from the child env and `arkiv/.env` is not loaded). Runs in a thread, never overlaps, retried next tick. |
| Coordinator | `IS_COORDINATOR=true`: also `upsert-pool` with `POOL_KEY_PATH` from `GET /pools/:pool_id` (members + layer map + status from the gateway); `coordinator_url_hash` = keccak256(`COORDINATOR_URL`). |
| Stop | SIGTERM to the agent (`~/.gpupool/agent.pid`), optional `stop-all.sh`, one `offline` upsert. Nobody extends it, so it disappears after 120 s. |

Live check (6 Nov 2026, this Linux laptop, `start --no-join` next to the running Parallax node, gateway on a fake pool):
node `0x4f24a8795047c2bb0d0c542780dc1d91f7f8cdc1` reported layers [29, 40) from the log; Arkiv node entity
`0x11e1d193d611d6acaa059026fcfef70c98a1d34aaa311ee4f0b5ad1cc60848a1` (tx from the node key), pool entity
`0xb3682573388a9e8c0a1f254087cd8a3d7ad17e6f12482c5f94c77f0536795044` (tx from the pool key, status `loading`: one node of three → no valid map).
After `stop --keep-parallax` the node listing was gone from `list-nodes` after the 120 s expiry.

## Post-MVP P5 (docs/POST_MVP_PLAN.md, SPEC §4.3)

| What | How |
|---|---|
| Peer ID (P5.4) | Read from `PEER_ID_FILE` (`pool/run/node.peer-id`, written by `pool/hooks` before the join; else the join log) and sent as `peer_id`. The gateway's admission allow-list is built from these signed heartbeats. |
| Served sessions (P5.9) | With `NOTIFY_PORT`, a listener on `127.0.0.1:NOTIFY_PORT/notify` takes Parallax `--notify-url` events and counts new distinct `session_id`s; each heartbeat sends `served_sessions` (kept if a heartbeat fails). |
| Memory (P5.7) | `usable_mem_gb`: Mac = memory − max(4 GB, 25 %); GPU = VRAM. `mem_pressure` = `swap_growing` when swap use grows > `SWAP_GROWTH_MB` within `SWAP_WINDOW_S` while Parallax runs (`sysctl vm.swapusage` / `/proc/meminfo`); the gateway then skips the pool. |
| LAN IP (P5.6) | `lan_ip` = local address used to reach the gateway. If it differs from `LAN_IP` in `pool/node.env`: `AUTO_RESTART=true` runs `pool/restart.sh --lan-ip <new>` (rewrites the env files, restarts); else prints the command once. The firewall allow-list still needs a human (sudo). |
| Clean restart (P5.5) | Heartbeat response `restart_id` > last executed → `AUTO_RESTART=true` runs `pool/restart.sh` (`--coordinator` on the coordinator; members `--join-delay RESTART_JOIN_DELAY_S`) in a background thread, then sends `restart_ack`. The ack is kept in `~/.gpupool/agent-state.json`. Output: `pool/logs/restart.log`. |
| Stale layers | Lines before the last `=== gpupool start` marker in the node log are ignored, so a restarting node never reports the old process's layers. |

Tests: `uv run pytest -q` (17 tests; `tests/test_p5.py` covers the parts above).

## SPEC §16.1 (automatic pools, election)

| What | How |
|---|---|
| Pool writer | Writes `gpupool.pool` only when the heartbeat response says `pool_writer` (gateway election), with the gateway's `coordinator_url_hash`. |
| `POOL_ID=auto` | Sends `p2p_port` (pool/node.env `TCP_PORT`) and measures TCP-connect delay to the `probe` peers (best of 3, background), reported as `rtt_ms`. On `assigned_pool`: `AUTO_RESTART=true` runs `pool/restart.sh --dht-prefix <prefix>` and keeps the pool in `~/.gpupool/agent-state.json`; else prints the command. |
