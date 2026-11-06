"""Node agent loop (SPEC §4.1): heartbeat to the gateway every HEARTBEAT_SECONDS, Arkiv
gpupool.node upsert + extend every ARKIV_EXTEND_SECONDS; on the coordinator also gpupool.pool."""
from __future__ import annotations

import json
import os
import signal
import threading
import time
from pathlib import Path

import httpx
from eth_account.signers.local import LocalAccount
from eth_utils import keccak

from . import arkiv, parallax
from .config import Config
from .signing import heartbeat_body, node_id, sign_body

STATE = Path("~/.gpupool/agent-state.json").expanduser()
PID = Path("~/.gpupool/agent.pid").expanduser()
SIG_HEADER = "x-gpupool-node-signature"


def now_ms() -> int:
    return int(time.time() * 1000)


def send_heartbeat(cfg: Config, acct: LocalAccount, client: httpx.Client) -> tuple[dict | None, parallax.Assignment, bool]:
    running = parallax.node_running()
    a = parallax.read_assignment(cfg.parallax_node_log) if running else parallax.Assignment()
    online = running and a.layers is not None
    body = heartbeat_body(node_id(acct), cfg.pool_id, now_ms(), online, a.model, a.layers if online else None, None)
    try:
        r = client.post(f"{cfg.gateway_url}/nodes/heartbeat", content=body, headers={"content-type": "application/json", SIG_HEADER: sign_body(acct, body)})
    except httpx.HTTPError as e:
        print(f"heartbeat: gateway unreachable: {e}", flush=True)
        return None, a, running
    if r.status_code != 200:
        print(f"heartbeat: HTTP {r.status_code}: {r.text[:300]}", flush=True)
        return None, a, running
    return r.json(), a, running


def node_entity(cfg: Config, acct: LocalAccount, gpu: str, mem_gb: float, owner: str, reliability: float, status: str, layers: list[int] | None) -> dict:
    return {"type": "gpupool.node", "owner_account": owner, "node_id": node_id(acct), "pool_id": cfg.pool_id, "gpu": gpu, "mem_gb": mem_gb,
            "status": status, "layers": layers, "tok_s": None, "reliability": reliability}


def pool_entity(cfg: Config, client: httpx.Client) -> dict | None:
    """gpupool.pool from the gateway's view (GET /pools/:pool_id: members + layer map from heartbeats)."""
    r = client.get(f"{cfg.gateway_url}/pools/{cfg.pool_id}")
    r.raise_for_status()
    s = r.json()
    if not s["models"]:
        print("pool: no model reported by any fresh node yet; pool listing skipped", flush=True)
        return None
    return {"type": "gpupool.pool", "pool_id": cfg.pool_id, "models": s["models"], "members": s["members"], "status": s["status"],
            "coordinator_url_hash": "0x" + keccak(text=cfg.coordinator_url).hex().removeprefix("0x"), "layer_map": s["layer_map"]}


def save_state(d: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(d))


def run(cfg: Config, acct: LocalAccount) -> None:
    gpu, mem_gb = parallax.detect_gpu()
    PID.parent.mkdir(parents=True, exist_ok=True)
    PID.write_text(str(os.getpid()))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    arkiv_busy = threading.Lock()
    last_arkiv = 0.0
    print(f"node {node_id(acct)} pool {cfg.pool_id} gpu {gpu} {mem_gb} GB; gateway {cfg.gateway_url}; log {cfg.parallax_node_log}", flush=True)

    def arkiv_write(entity: dict, pool: dict | None) -> None:
        if not arkiv_busy.acquire(blocking=False):
            return  # previous write still running; never overlap
        try:
            r = arkiv.upsert_node(entity, cfg.node_key_path, cfg.arkiv_env)
            print(f"arkiv node {entity['status']}: {r.get('entityKey')} tx {r.get('txHash')} created={r.get('created')}", flush=True)
            if pool:
                p = arkiv.upsert_pool(pool, cfg.pool_key_path, cfg.arkiv_env)
                print(f"arkiv pool {pool['status']}: {p.get('entityKey')} tx {p.get('txHash')} created={p.get('created')}", flush=True)
        except Exception as e:  # logged; retried at the next tick
            print(f"arkiv: write failed, retry in {cfg.arkiv_extend_seconds}s: {e}", flush=True)
        finally:
            arkiv_busy.release()

    with httpx.Client(timeout=10) as client:
        while not stop.is_set():
            resp, a, running = send_heartbeat(cfg, acct, client)
            if resp:
                # online = Parallax node runs and has layers; loading = runs, no layers yet; offline = not running.
                status = "online" if (running and a.layers) else ("loading" if running else "offline")
                save_state({"owner_account": resp["owner_account"], "reliability": resp["reliability"], "gpu": gpu, "mem_gb": mem_gb})
                print(f"heartbeat ok: {status} layers {a.layers} model {a.model}", flush=True)
                if time.monotonic() - last_arkiv >= cfg.arkiv_extend_seconds:
                    last_arkiv = time.monotonic()
                    entity = node_entity(cfg, acct, gpu, mem_gb, resp["owner_account"], resp["reliability"], status, a.layers if status == "online" else None)
                    pool = None
                    if cfg.is_coordinator:
                        try:
                            pool = pool_entity(cfg, client)
                        except httpx.HTTPError as e:
                            print(f"pool: gateway /pools failed: {e}", flush=True)
                    threading.Thread(target=arkiv_write, args=(entity, pool), daemon=True).start()
            stop.wait(cfg.heartbeat_seconds)
    # Let a running Arkiv write finish before exit.
    with arkiv_busy:
        pass
    PID.unlink(missing_ok=True)
    print("agent stopped", flush=True)


def offline_listing(cfg: Config, acct: LocalAccount) -> None:
    """`stop`: set the listing to offline once. Nobody extends it after that, so it expires (120 s)."""
    if not STATE.exists():
        print("no agent state (never got a heartbeat answer): nothing to set offline", flush=True)
        return
    s = json.loads(STATE.read_text())
    entity = node_entity(cfg, acct, s["gpu"], s["mem_gb"], s["owner_account"], s["reliability"], "offline", None)
    r = arkiv.upsert_node(entity, cfg.node_key_path, cfg.arkiv_env)
    print(f"arkiv node offline: {r.get('entityKey')} tx {r.get('txHash')} (expires in 120 s unless extended)", flush=True)
