# x402 proof of concept (HANDOFF step 1.6)

Paywalled `GET/POST /echo` (Hono) + a client that pays in **native HBAR on Hedera testnet** and prints the HashScan link.

```bash
cp .env.example .env    # X402_PAY_TO (treasury 0.0.x), AGENT_ACCOUNT_ID / AGENT_PRIVATE_KEY
pnpm --filter @gpupool/x402-poc server
pnpm --filter @gpupool/x402-poc client  # spends testnet HBAR (0.02 HBAR at the default price)
pnpm --filter @gpupool/x402-poc test    # offline: fake facilitator, 402 shape, prices, HashScan link
```

Price: `shared/config` x402 tier of `X402_POC_MODEL` for `X402_POC_MAX_TOKENS` (default 14B, ≤512 tokens → `2000000` tinybar = 0.02 HBAR).

**Status:** verified live on Hedera testnet (6 Nov 2026, step 1.6 done).

| Settled x402 payment | |
|---|---|
| Transaction ID | `0.0.9185802@1793929496.997341480` (fee payer = x402.org facilitator) |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9185802-1793929496-997341480 |
| Result | `SUCCESS`, `CRYPTOTRANSFER`: agent `0.0.11332604` −2,000,000 tinybar (0.02 HBAR) → treasury `0.0.11331600` +2,000,000 |
| Settle response | `{"success":true,"payer":"0.0.11332604","transaction":"0.0.9185802@1793929496.997341480","network":"hedera:testnet"}` |

## Findings (checked 2026-11-06)

| Item | Finding |
|---|---|
| Packages | `@x402/core`, `@x402/hono`, `@x402/fetch`, `@x402/hedera`, all **2.30.0** (protocol **x402 v2**). Repo: https://github.com/x402-foundation/x402 (formerly coinbase/x402). The v1 packages (`x402`, `x402-hono`, `x402-fetch`) have no Hedera support. |
| Scheme spec | https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md |
| Hedera docs | https://docs.hedera.com/solutions/ai/x402 (also `/exact-scheme`, `/facilitators`) |
| Network ID | CAIP-2 `hedera:testnet` (register the scheme on `hedera:*`) |
| Asset / units | native HBAR = asset `"0.0.0"`; `amount` = **tinybars** as a decimal string. A `"$0.01"` price string means USDC (`0.0.429274`), not HBAR: pass `{ asset: "0.0.0", amount }`. |
| Facilitators (no API key) | `https://x402.org/facilitator` (testnet fee payer `0.0.9185802`), `https://api.testnet.blocky402.com` (`0.0.7162784`), `https://testnet.facilitator.launa.dev`, `https://facilitator.ultravioletadao.xyz`. The facilitator is the **fee payer**: it co-signs and submits the transfer. Check `GET <url>/supported`. |
| 402 response | HTTP 402; requirements in the **`PAYMENT-REQUIRED`** header (base64 JSON), body `{"error":"Payment required"}`. Decoded: `{"x402Version":2,"error","resource":{url,description,mimeType},"accepts":[{"scheme":"exact","network":"hedera:testnet","amount":"2000000","asset":"0.0.0","payTo":"0.0.1234","maxTimeoutSeconds":120,"extra":{"feePayer":"0.0.9185802"}}]}` (observed from this server). |
| Payment header | client → **`PAYMENT-SIGNATURE`** (base64 PaymentPayload with a partially signed `TransferTransaction`). Server → **`PAYMENT-RESPONSE`** (base64 SettleResponse). v1 names `X-PAYMENT` / `X-PAYMENT-RESPONSE` are legacy. |
| Settle response | `{success, transaction, network, payer}` (code 2.30.0). `payer` = the **client's Hedera account ID** `0.0.x`. `transaction` = Hedera tx ID `0.0.<feePayer>@<sec>.<nanos>`: the account in the tx ID is the **facilitator's fee payer**, not the client. (The scheme spec doc says `transactionId` and payer = fee payer; the code differs; we follow the code.) |
| HashScan | `https://hashscan.io/testnet/transaction/0.0.x-<sec>-<nanos>` (dash form; also the mirror node form) |

Compared with `shared`: `X402PaymentEvent.payer` (`HederaAccountId`) and `tx_id` (`HederaTxId`, `0.0.x@sec.nanos`) **match the formats**. No `shared` change.
Note for 2.4: the account inside `tx_id` is the facilitator, so do not read the payer from the tx ID; use `payer`.

## Gotchas

1. The client's default spend controls **block HBAR** (only default assets, $1 cap): set `allowedAssets: [{ network, asset: "0.0.0", maxAmountPerPayment }]` (done in `src/client.ts`, cap = `AGENT_BUDGET_HBAR`).
2. Import `PrivateKey` etc. from `@x402/hedera`, not `@hiero-ledger/sdk` (a second SDK copy fails at runtime).
3. `payTo` must be an existing `0.0.x` account (facilitators reject EVM aliases).
4. The facilitator checks the payer's balance via the mirror node (a few seconds of lag after funding).
5. The transfer is valid ~120 s and its ID uses the local clock: pay at once; keep the clock in sync.
6. The middleware fetches the facilitator's `/supported` at start (`syncFacilitatorOnStart`): the server needs network access to it.
7. The default flow settles **after** the handler and does not settle if the handler returns ≥ 400: a failed inference is not charged.
8. Keep every `@x402/*` package on the same 2.30.x.
