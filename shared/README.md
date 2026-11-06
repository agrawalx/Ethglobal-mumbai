# shared (Step 0 interfaces)

Cross-component interfaces. Zod schemas in `src/` are the source; TS types come from `z.infer`.
Every schema has a JSON example in `examples/`. Static network config is `config/gpupool.config.json`.
Non-TS components (Python node agent, Solidity contract) use the JSON examples and the rules below.

```bash
pnpm install
pnpm --filter @gpupool/shared typecheck   # tsc --noEmit
pnpm --filter @gpupool/shared test        # every example parses with its schema
```

Use: `import { Receipt, LedgerEvent } from "@gpupool/shared"` (workspace package; Node 24 runs the `.ts` directly).
Next.js needs `transpilePackages: ["@gpupool/shared"]` in `next.config`.

| File | Contents | SPEC |
|---|---|---|
| `src/common.ts` | Units, IDs, layer range, route, credit split | §5.5, §8.3 |
| `src/api.ts` | Gateway HTTP request/response bodies, headers, error shape | §5.2 |
| `src/session.ts` | Session JWT claims | §6.2 |
| `src/hcs.ts` | HCS ledger event union | §8.6, §10.2 |
| `src/arkiv.ts` | Arkiv entities + indexed fields | §11.2 |
| `src/merkle.ts` | Epoch payout leaf, proof | §10.5 |
| `src/config.ts` | Config schema (models, layers, factors, prices, splits, TTLs) | §5.5, §7.3, §8, §9, §11 |
| `src/canonical.ts` | Canonical JSON (event signatures, prompt hash) | §10.2 |

## Rules every component must follow

**Units**
- Credits: integer **millicredits** (`*_mc`, 1 credit = 1000 mc) in SQLite, HCS, and the API. No floats in the ledger.
- Credit split: `nodes_share = floor(cost × 90%)`; each node gets `floor(nodes_share × layers_served / total_layers)`; burn = `floor(cost × 5%)`; reserve = cost − nodes − burn (reserve takes the rounding remainder). The parts sum exactly to the cost.
- Cost: `cost_mc = floor(model_factor × (out + 0.2 × in) × 1000)` (integer form in `gateway/src/ledger.ts`). Hold: same formula with `max_tokens` and `in = ceil(chars of all messages / 4)`. Settle never charges more than the hold.
- Self-request rule (confirmed): a node that serves its own owner's request gets 0; its share goes to the network reserve. One function: `paysNode` in `gateway/src/ledger.ts`.
- Route unknown (`route: null`, no valid layer map): every node share goes to reserve.
- HBAR: tinybars as a decimal string (`amount_tinybar`). Inside the EVM, `msg.value` is tinybars.
- Times: Unix milliseconds (`ts`), except JWT `iat`/`exp` (seconds).
- Shares in config: basis points (10000 = 100%).

**IDs**
- `node_id` = EVM address of the node key (`~/.gpupool/node.key`).
- EVM addresses are **lowercase** at every boundary (API, HCS, Arkiv). Convert checksummed addresses before sending.
- `account_id` = `acc_…`, `req_id` = `req_…`. The World nullifier never leaves the gateway.
- Epoch number = `floor(epoch_start_unix_seconds / EPOCH_SECONDS)`.

**Route**
- Ordered list `[{node_id, layers: [start, end)}]`, half-open. Built by the gateway from node heartbeats (SPEC §5.5). Valid only if it covers `[0, num_layers)` of the model exactly once. `null` = unknown (in `Receipt`, `x402_payment`, `gpupool.pool.layer_map`).

**Hashes**
- sha256, `0x` + 64 hex (`Hex32`). `prompt_hash` = sha256 of the canonical JSON of the request `messages`; `resp_hash` = sha256 of the UTF-8 response text.

**Canonical JSON** (used for HCS event signatures)
- `canonicalJson()` in `src/canonical.ts`. Keys sorted recursively, no whitespace, UTF-8. Python (byte-equal, tested): `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.

**Signatures**
- HCS events: `sig` = ed25519 (`GATEWAY_SIGNING_KEY`, raw 32-byte seed) over the canonical JSON of the event without `sig`. Hex, `0x`-prefixed. The HCS message is the canonical JSON with `sig`. Check one: `node gateway/src/verify-event.ts <seq> <gateway_pubkey>`; gateway public key `0x9750f108f4273406aa7498086fc73b404633e5750d9f1d3dacfd95c1cc58c508`.
- `POST /nodes/heartbeat`: header `x-gpupool-node-signature` = EIP-191 `personal_sign` by the node key over the **raw request body bytes** (Python: `encode_defunct(primitive=body)`, send `content=body`). `ts` in the body must be within 60 s of gateway time. Cross-language vector: `node-agent/tests/fixtures/signature-vector.json` (checked by `gateway/test/cross-language.test.ts`).
- `POST /nodes/register`: `node_sig` = EIP-191 `personal_sign` by the node key over the string `gpupool-register:<node_id>:<pool_id>:<ts>`. `gpupool-node init` makes it and puts the fields in the registration link. `ts` must be < 24 hours old.

**Merkle tree** (gateway and `EpochPayout.sol` must agree)
- leaf = `keccak256(abi.encodePacked(address payout_address, uint256 amount_tinybar))`.
- pair hash = `keccak256` of the two 32-byte values, smaller first (OpenZeppelin `MerkleProof`).
- One leaf per payout address per epoch. No zero-amount leaves. One leaf: root = leaf, proof = `[]`.
- Tree build: sort leaves ascending by leaf hash; hash neighbours in pairs left to right; an unpaired last node moves up unchanged. Vector: `contracts/test/fixtures/merkle-vector.json`.

**HTTP**
- Every error: `{"error": {"code": "...", "message": "..."}}` (codes in `ErrorCode`). The x402 402 body is owned by the x402 library.
- Status codes: 401 `unauthorized` (bad/missing session, bad signature, World rejected); 402 only for x402; **403 `insufficient_credits`** (session user cannot cover the hold); 403 `node_limit_reached`; 409 node owned by another account.
- Every `/v1/chat/completions` response has header `x-gpupool-request-id`. The client reads route, cost, and HCS seq from `GET /requests/:id`.
- Unknown request fields are stripped (so `logprobs` never reaches Parallax).

**Arkiv**
- Fields in `ARKIV_INDEXED` are queryable annotations; the rest go in the payload. `type` is always indexed.

## Not pinned yet (HANDOFF §9)
- ~~IDKit v4 formats~~ `RpSignatureResponse` pinned (step 2.1). `WorldVerifyRequest` stays opaque: the IDKit result is forwarded unchanged.
- ~~x402 formats~~ Confirmed (step 1.6): settle response `payer` = client Hedera account ID, `transaction` = Hedera tx ID `0.0.<facilitator fee payer>@sec.nanos`. Both match `HederaAccountId` / `HederaTxId`. The 402 requirements come in the `PAYMENT-REQUIRED` header (library-owned).
- ~~Arkiv `models` array~~ Decided (step 1.4): indexed slots `model0..model3`; see `arkiv/schema.md`.
