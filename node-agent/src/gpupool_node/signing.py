"""Signatures (shared/README.md "Signatures"). Must match the gateway verifier byte for byte."""
from __future__ import annotations

import json

from eth_account.messages import encode_defunct
from eth_account.signers.local import LocalAccount


def node_id(acct: LocalAccount) -> str:
    """node_id = EVM address of the node key, lowercase."""
    return acct.address.lower()


def register_message(nid: str, pool_id: str, ts: int) -> str:
    return f"gpupool-register:{nid}:{pool_id}:{ts}"


def sign_register(acct: LocalAccount, pool_id: str, ts: int) -> str:
    """EIP-191 personal_sign over the UTF-8 string gpupool-register:<node_id>:<pool_id>:<ts>."""
    sig = acct.sign_message(encode_defunct(text=register_message(node_id(acct), pool_id, ts))).signature
    return "0x" + sig.hex().removeprefix("0x")


def heartbeat_body(nid: str, pool_id: str, ts: int, online: bool, model: str | None, layers: list[int] | None, tok_s: float | None) -> bytes:
    """Raw request body (shared NodeHeartbeat). These exact bytes are signed and sent."""
    body = {"node_id": nid, "pool_id": pool_id, "ts": ts, "online": online, "model": model, "layers": layers, "tok_s": tok_s}
    return json.dumps(body, separators=(",", ":")).encode("utf-8")


def sign_body(acct: LocalAccount, body: bytes) -> str:
    """Header x-gpupool-node-signature: EIP-191 personal_sign over the raw body bytes."""
    sig = acct.sign_message(encode_defunct(primitive=body)).signature
    return "0x" + sig.hex().removeprefix("0x")
