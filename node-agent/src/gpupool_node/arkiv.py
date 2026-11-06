"""Arkiv writes through the `@gpupool/arkiv` CLI (arkiv/src/cli.ts), signed by the node's OWN key.

The CLI is run WITHOUT --env-file: arkiv/.env holds the gateway's ARKIV_PRIVATE_KEY, and the
listing must be owner-signed by the node key (SPEC §11.3). So the child env gets ARKIV_KEY_PATH
= the key file and ARKIV_PRIVATE_KEY removed.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from .config import REPO

CLI = REPO / "arkiv" / "src" / "cli.ts"


def run_cli(args: list[str], key_path: Path | None, arkiv_env: dict[str, str], timeout: int = 90) -> dict | list:
    env = {k: v for k, v in os.environ.items() if k != "ARKIV_PRIVATE_KEY"}
    env.update(arkiv_env)
    env.pop("ARKIV_PRIVATE_KEY", None)
    if key_path is not None:
        env["ARKIV_KEY_PATH"] = str(key_path)
    r = subprocess.run(["node", str(CLI), *args], capture_output=True, text=True, env=env, timeout=timeout, cwd=REPO / "arkiv")
    if r.returncode != 0:
        raise RuntimeError(f"arkiv {args[0]} failed: {r.stderr.strip() or r.stdout.strip()}")
    return json.loads(r.stdout)


def upsert_node(entity: dict, key_path: Path, arkiv_env: dict[str, str]) -> dict:
    return run_cli(["upsert-node", json.dumps(entity)], key_path, arkiv_env)  # type: ignore[return-value]


def upsert_pool(entity: dict, key_path: Path, arkiv_env: dict[str, str]) -> dict:
    return run_cli(["upsert-pool", json.dumps(entity)], key_path, arkiv_env)  # type: ignore[return-value]


def list_nodes(pool_id: str, arkiv_env: dict[str, str]) -> list:
    return run_cli(["list-nodes", pool_id], None, arkiv_env)  # type: ignore[return-value]
