# gateway (C3-C6, TypeScript)

OpenAI-compatible API, World login, x402, credit ledger (SQLite), HCS writer, node registry/heartbeats.
Spec: `docs/SPEC.md` §5-10. Node 24 + Hono + `better-sqlite3` (WAL).

```bash
cp .env.example .env
pnpm --filter @gpupool/gateway start
pnpm --filter @gpupool/gateway test        # fake Parallax / World / facilitator, no network
node test/fake-parallax.ts 3200            # fake pool for live checks (never use port 3001 for this)
node --env-file=.env scripts/dev-session.ts <label>   # DEV ONLY: account + session without World (needs the DB file + JWT_SECRET)
node src/verify-event.ts <seq> <gateway_pubkey>       # anyone: check one HCS message (mirror node + ed25519)
```

## Endpoints (step 2)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /v1/chat/completions` | session **or** x402 | Bearer present → must be valid (else 401). Session: hold → forward → settle from `usage` (`src/billing.ts`, `src/ledger.ts`). No Bearer: x402 (`src/x402.ts`). |
| `POST /auth/world/rp-signature` | none | `RpSignatureResponse` (IDKit v4 RP signature). |
| `POST /auth/world/verify` | none | IDKit result forwarded unchanged → `WorldVerifyResponse` (JWT HS256, 24 h). |
| `GET /me` | session | `MeResponse`. |
| `POST /nodes/register` | session | `NodeRegisterRequest` from the `gpupool-node init` link. Max 3 nodes. Payout address required once → `payout_address_set`. |
| `POST /nodes/heartbeat` | node signature | EIP-191 over the raw body, ts ± 60 s, registered nodes only. → `HeartbeatResponse`. |
| `GET /pools/:pool_id` | none | `PoolStateResponse` (members + layer map from fresh heartbeats). The coordinator writes `gpupool.pool` from it. |
| `GET /requests/:id` | none | `Receipt` (route, cost, split, x402 payer/tx, hcs_seq). |
| `GET /v1/models` | none | TEMP until step 3.1: config models the pool's `/v1/models` reports. |

Errors: shared shape. 401 unauthorized, 402 only x402, **403 `insufficient_credits`**, 403 `node_limit_reached`, 409 node of another account, 502 `pool_error`.

## Credits (step 2.2)

- Hold = `model_factor × (max_tokens + 0.2 × ceil(chars/4))`, one conditional `UPDATE` (concurrent requests cannot overspend). Starter credits count only before `starter_expires_at`.
- Settle (one transaction): cost from `usage`, capped at the hold; starter first, then earned; split 90/5/5 by layers; **self-request rule** (`paysNode`): the requester's own node gets 0, the share goes to reserve; route unknown → all node shares to reserve. `request_settled` event, `requests` row, `transcripts` (7 days).
- Failed request: hold released, cost 0, `node_reliability.requests_routed` +1 without `requests_ok` (client abort: no penalty). No event.
- Starter expiry job: every 60 s, `credits_expired` event.
- Route (SPEC §5.5, `src/route.ts`): latest fresh heartbeats of the pool's nodes; valid only if they cover `[0, num_layers)` exactly once.
- Uptime: heartbeats count `heartbeats_received`; `heartbeats_expected` and the score are step 3.2.

## HCS (step 2.3)

Events are signed (ed25519, `GATEWAY_SIGNING_KEY` seed) and inserted into `ledger_events` in the same transaction as the balance change. `src/hcs.ts` submits unsent rows in id order every second (back-off up to 30 s on failure; restart-safe) and fills `ledger_events.hcs_seq` and `requests.hcs_seq`. Requests never wait for HCS.
Gateway public key: `0x9750f108f4273406aa7498086fc73b404633e5750d9f1d3dacfd95c1cc58c508`. Topic `0.0.11332608`: https://hashscan.io/testnet/topic/0.0.11332608
Live (6 Nov): seq 1 `account_created` for `acc_hcslivecheck23` (synthetic live-check event, no such account: ignore it when rebuilding), seq 2-3 `x402_payment`, seq 4-5 dev account `account_created` + `starter_grant`, seq 6 `payout_address_set` (local test DB, placeholder address), seq 7 `request_settled`; seq 1-7 all `schema: valid, signature: valid` with `verify-event.ts`.

## x402 (step 2.4)

`@x402/core` `x402HTTPResourceServer` directly, not the `@x402/hono` middleware: the middleware settles **after** the handler and buffers the whole response (breaks streaming), and SPEC §7.2 settles before serving. The price is a `DynamicPrice` from the parsed body (shared config tier for model + max_tokens). No `PAYMENT-SIGNATURE` → 402 with `PAYMENT-REQUIRED`. With it → facilitator verify → settle → forward; `PAYMENT-RESPONSE` on the answer. The facilitator `/supported` is fetched on the first paid request.
**Paid but the pool failed:** recorded as `status=failed` with payer/tx/amount, no `x402_payment` event, **no refund** (out of scope).
Live (6 Nov, agent-client, 2 questions, fake pool): `0.0.9185802@1793930570.679764006`, `0.0.9185802@1793930571.004892345` (SUCCESS, 0.02 HBAR each to treasury `0.0.11331600`).

## World ID (step 2.1), IDKit v4 findings (checked 6 Nov 2026)

| Item | Finding |
|---|---|
| RP signature | `signRequest({signingKeyHex, action})` from `@worldcoin/idkit-core/signing` 4.6.0 (from `@worldcoin/idkit-server` 1.2.0). secp256k1, EIP-191 over `0x01 ‖ nonce(32) ‖ created_at(u64 BE) ‖ expires_at(u64 BE) ‖ hash_to_field(action)` (81 bytes); `sig` = r‖s‖v; ttl 300 s. `rp_id` and signal are not signed. Docs: https://docs.world.org/world-id/idkit/signatures |
| Frontend use | `rp_context = { rp_id, nonce, created_at, expires_at, signature: sig }`, plus `app_id`, `action`, `environment` (all in our response). Selfie: the `selfieCheck({signal})` preset. https://docs.world.org/world-id/idkit/integrate |
| Verify | `POST https://developer.world.org/api/v4/verify/{rp_id}`, **no auth**, body = IDKit result unchanged. 200 `{success:true, nullifier:"0x…", environment, results:[{identifier, success, nullifier}], message}`. https://docs.world.org/api-reference/developer-portal/verify |
| Credential | `results[].identifier`: `proof_of_human` (Orb), `selfie` (Selfie Check, `issuer_schema_id` 11). Legacy v3: `orb`, `face`. We accept those; others (`passport`, …) → 401. |
| Duplicate | The portal returns **200** for a reused nullifier (`"Proof verified successfully (nullifier reuse)"`). Our `world_nullifier` UNIQUE (stored as 32-byte lowercase hex) is the only guard. |
| Errors | `{code, detail, attribute}` (e.g. 400 `validation_error`, `rp_not_active`, `app_not_migrated`) or `{success:false, code, detail, results}` (400 `all_verifications_failed`). We return 401 `unauthorized` with `code: detail`. |
| Live check | Invalid proofs to our `rp_831104fa5fd04dd5`: Selfie → 400 `validation_error` "sybil_score is required…"; Orb → 400 `all_verifications_failed`. So the URL and RP are valid; the shapes match. |
| Not verified | A real World App / simulator login (needs the frontend + a phone/simulator). Whether World App blocks a second proof for the same action (repeat login) is unconfirmed; if it does, repeat logins need IDKit session proofs. Pre-create the action `gpupool-account` in the portal (staging) to be safe. |

SQLite: all SPEC §8.7 tables (`src/db.ts`), `SCHEMA_VERSION` 2 (nodes have the latest heartbeat columns; `requests.route` nullable). No migrations: delete the DB file when the version changes.

Unverified: that Parallax honours `stream_options.include_usage` (if not, streaming requests end with `ok:false, reason:"no_usage"` and cost nothing); real inference through the gateway (only one node exists now).
