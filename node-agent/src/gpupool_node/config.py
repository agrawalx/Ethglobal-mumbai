"""Env for the node agent (node-agent/.env.example, HANDOFF §8). Process env overrides the file."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]  # node-agent/src/gpupool_node → repo root


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


@dataclass(frozen=True)
class Config:
    gateway_url: str
    frontend_url: str
    node_key_path: Path
    pool_id: str
    is_coordinator: bool
    pool_key_path: Path
    coordinator_url: str
    arkiv_env: dict[str, str]
    heartbeat_seconds: int
    arkiv_extend_seconds: int
    parallax_node_log: Path


def load(env_file: Path | None = None) -> Config:
    # Empty values count as unset, so the defaults below apply.
    env = {k: v for k, v in {**read_env_file(env_file or REPO / "node-agent" / ".env"), **os.environ}.items() if v != ""}

    def need(k: str) -> str:
        v = env.get(k, "")
        if not v:
            raise SystemExit(f"error: {k} is not set (see node-agent/.env.example)")
        return v

    exp = lambda p: Path(os.path.expanduser(p))  # noqa: E731
    return Config(
        gateway_url=need("GATEWAY_URL").rstrip("/"),
        frontend_url=env.get("FRONTEND_URL", "http://localhost:3000").rstrip("/"),
        node_key_path=exp(env.get("NODE_KEY_PATH", "~/.gpupool/node.key")),
        pool_id=need("POOL_ID"),
        is_coordinator=env.get("IS_COORDINATOR", "false").lower() == "true",
        pool_key_path=exp(env.get("POOL_KEY_PATH", "~/.gpupool/pool.key")),
        coordinator_url=env.get("COORDINATOR_URL", "http://127.0.0.1:3001"),
        arkiv_env={k: env[k] for k in ("ARKIV_RPC_URL", "ARKIV_CHAIN_ID", "ARKIV_ACCESS_KEY") if env.get(k)},
        heartbeat_seconds=int(env.get("HEARTBEAT_SECONDS", "10")),
        arkiv_extend_seconds=int(env.get("ARKIV_EXTEND_SECONDS", "30")),
        parallax_node_log=exp(env.get("PARALLAX_NODE_LOG", str(REPO / "pool" / "logs" / "node.log"))),
    )
