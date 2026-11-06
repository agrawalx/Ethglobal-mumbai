# Docs page: API keys, credits and HBAR top-ups (spec for the builder)

The docs page does not exist yet. This file says what its **API keys** part must do, and which
backend calls it uses. The backend is finished and tested (see "Verified" at the end). You only
build the UI.

The part has three blocks, in this order:

1. **Generate API key**: a button that gives the signed-in user an OpenAI-compatible key for OpenCode.
2. **Your credits**: the signed-in user's credits and the credits of **their own** keys, with links.
3. **Add credits with Hedera testnet HBAR (x402)**: the steps to raise a key's balance.

Rules that apply to the whole part:

- **Only the signed-in user's data.**
  - Every number comes from session calls (`GET /me`, `GET /agents`), which return only the keys of that World account (user id).
  - Do **not** add a "paste any key to see its credits" box on the docs page.
  - `GET /v1/credits` is for the key holder's own tools, not for this page.
- **Not signed in:** show the three blocks as text, with one "Sign in with World ID" button where the numbers would be. No calls that need a session.
- **Credits on screen:** the API returns millicredits (`*_mc`); show credits = `mc / 1000`.
- **Testnet only.** HBAR means Hedera **testnet** HBAR. Never show mainnet wording.
- **No private keys in the browser.** The docs page never asks for a Hedera private key. Top-ups are signed on the user's own computer (block 3).

---

## Reuse what exists in `frontend/`

| Need | Use |
|---|---|
| Session token, `me`, sign-in | `useSession()` from `src/auth/context` (`session.token`, `session.me`, `session.loading`) and the existing World sign-in flow |
| Create / list / revoke keys, key usage | `api.createKey(token, name, cap)`, `api.keys(token)`, `api.revokeKey(token, id)`, `api.keyRequests(token, id)` from `src/data` (live adapter = the endpoints below; mock adapter for tests) |
| Available account credits | `available(me.balance)` and `liveStarter(me.balance)` from `src/lib/credits` |
| Price and pool context | `api.models()`: `price?.credits_per_1k_out`, `price?.multiplier`, `context_length?` (fallback: shared config) |
| `opencode.json` text, copy buttons | `opencodeJson()` in `src/pages/Keys.tsx` (move it to a shared helper), `CopyButton` / `CodeBox` from `src/components/console/CopyButton` |
| Top-up rate and limits | `config.topup` from `shared/config/gpupool.config.json` (`credits_per_hbar` = 10, `min_hbar` = 1, `max_hbar` = 1000) |

The `/keys` console page already does most of this. The docs part is a shorter version of it with a guided flow.

---

## Block 1: "Generate API key"

**UI:** a name field (default `opencode`), an optional cap in credits ("no cap: the whole balance"), and a primary button **Generate API key**.

**Click:**

```
POST /agents
Authorization: Bearer <session token>
Content-Type: application/json

{ "name": "opencode" }                       // no cap
{ "name": "opencode", "budget_mc": 500000 }  // cap 500 credits (credits × 1000)
```

`api.createKey(token, name, cap)` does this. It leaves out `budget_mc` when the cap is null.

**200 response** (`AgentKeyCreateResponse`, example `shared/examples/agent-key-create-response.json`):

```json
{ "agent_id": "agt_3Qx8Lm", "name": "opencode", "budget_mc": null, "spent_mc": 0, "revoked": false,
  "created_at": 1795121600000, "last_used_at": null, "key_credits_mc": 0, "bought_total_mc": 0,
  "token": "gpa_agt_3Qx8Lm_<64 hex>" }
```

**After success, show:**

1. **The token, once,** with a Copy button and the text "Store this key now. It is not shown again." The gateway keeps only a hash. Do not store the token in localStorage, do not log it, and do not send it anywhere else.
2. **"Use it in OpenCode"** with three copyable steps:
   - `export GPUPOOL_API_KEY=gpa_…` (fill in the real token in the copy text);
   - save this as `opencode.json` in the project (base URL = the gateway origin + `/v1`; context = pool context; output = 2048):

     ```json
     {
       "$schema": "https://opencode.ai/config.json",
       "provider": {
         "gpupool": {
           "npm": "@ai-sdk/openai-compatible",
           "name": "GPU Pool",
           "options": { "baseURL": "<gateway>/v1", "apiKey": "{env:GPUPOOL_API_KEY}" },
           "models": { "Qwen/Qwen3-14B-FP8": { "name": "Qwen3 14B on GPU Pool", "limit": { "context": 4096, "output": 2048 } } }
         }
       },
       "model": "gpupool/Qwen/Qwen3-14B-FP8"
     }
     ```
   - run `opencode` and pick the model with `/models`.
3. One line: "Any OpenAI-compatible client works: base URL `<gateway>/v1`, API key = this token."
4. **Refresh block 2.** The new key appears in the list.

**Errors:**

| Status | Show |
|---|---|
| 401 | "Sign in again" + the World sign-in button (the session expired) |
| 400 | the message under the form (bad name or cap) |
| 403 | "This account cannot create keys" (banned account) |
| network error | "The gateway is not reachable" + Retry |

**What the key does:** it is a normal OpenAI-compatible bearer key for `POST /v1/chat/completions` (streaming, tools). The gateway handles tool calls, trims long sessions and picks the answer length. See `docs/OPENCODE.md`.

---

## Block 2: "Your credits" (signed-in user only)

Load both on open, after generating a key, and after the user comes back to the tab (`visibilitychange`):

```
GET /me      Authorization: Bearer <session>   → MeResponse   (shared/examples/me-response.json)
GET /agents  Authorization: Bearer <session>   → { agents: AgentKey[] }  (shared/examples/agent-key-list-response.json)
```

**Account summary:**

| Label | Value | Note |
|---|---|---|
| Available now | `liveStarter + earned − held` (`available(me.balance)`) | what any key without bought credits can spend |
| Starter | `balance.starter_mc` (0 once `starter_expires_at` has passed) | 10,000 at first sign-in, spent first |
| Earned | `balance.earned_mc` | from lending a laptop to the pool |
| Spent so far | `balance.spent_total_mc` | account credits only; bought key credits are counted per key |

**Per key** (one row per `agents[]` item; revoked keys greyed out):

| Column | Field |
|---|---|
| Name / id | `name`, `agent_id` |
| Bought credits left | `key_credits_mc`: only this key spends them, and it spends them **first** |
| Bought in total | `bought_total_mc` |
| Spent | `spent_mc` (bought + account) |
| Cap | `budget_mc` (null = "no cap"). The cap limits account credits only, never bought credits. |
| Last used | `last_used_at` (null = "never") |

A key can spend now: `key_credits_mc + min(Available now, cap left)`. Show it as "Can spend now" if there is room.

**Optional per-key expand:** "Usage" → `GET /agents/:id/requests` (session; 404 if not this user's key), with a receipt link per request: `/requests/:req_id`, shown as a receipt sheet like `/keys` does.

**Price note:** "1 credit is not 1 token. The price depends on the model and how busy the pool is (0.5×–2×, locked per request). You pay only for the tokens the pool runs." Show `price.credits_per_1k_out` and `price.multiplier` from `GET /v1/models` when present.

**Links in this block:**

- Keys console: `/keys` (revoke, caps, usage);
- Account: `/account` (balance details, lend a laptop to earn credits);
- Ledger: `/ledger` (every top-up and charge is an HCS event: `credits_purchased`, `request_settled`);
- `docs/OPENCODE.md` (how the gateway serves OpenCode).

---

## Block 3: "Add credits with Hedera testnet HBAR (x402)"

**Rate:** **1 testnet HBAR = 10 credits.** 1 to 1000 HBAR per top-up. Read these from `config.topup`; do not hard-code them.

**Who gets the credits:** the **one key** used for the top-up. They are not shared with the account or other keys.

**Spending order:** that key spends its bought credits first, then the account's credits within its cap.

**Why there is no "Pay" button on this page:** an x402 payment is a Hedera transfer signed with the payer's private key. The page must never ask for that key, so the signing happens on the user's computer with the repo's `agent-client`. (A wallet button, for example HashPack, can come later; it would call the same endpoint.)

**Steps to show** (numbered, each with a copy button where there is a command):

1. **Get a Hedera testnet account.** Sign up at the Hedera Portal (https://portal.hedera.com), pick **Testnet**, and create an account. Note the **Account ID** (`0.0.…`) and the **DER-encoded private key**. New testnet accounts come with test HBAR. For more, use the faucet: https://portal.hedera.com/faucet.
2. **Generate an API key** (block 1) and copy its token.
3. **Fill in `agent-client/.env`** on your computer (the file stays local and is never committed):

   ```sh
   GATEWAY_URL=<gateway origin>
   GPUPOOL_API_KEY=gpa_…            # the key to add credits to
   AGENT_ACCOUNT_ID=0.0.…           # your Portal testnet account
   AGENT_PRIVATE_KEY=302e…          # its DER private key (stays on this computer)
   HEDERA_NETWORK=testnet
   ```

4. **Check, then pay:**

   ```sh
   cd agent-client
   pnpm install
   pnpm topup --check        # the key's credits now
   pnpm topup --hbar 5       # pay 5 testnet HBAR → +50 credits on this key
   ```

   The command shows the credits before and after, and the HashScan link of the payment (`https://hashscan.io/testnet/transaction/…`).
5. **Back on the docs page:** block 2 shows the new "Bought credits left" after a refresh (or on tab focus).

**Under the hood (one short paragraph, collapsible):**

1. `POST /v1/credits/topup {"hbar": 5}` with the API key.
2. The gateway answers 402 with x402 requirements for exactly `5 × 10^8` tinybar in HBAR to the treasury.
3. The CLI signs the transfer.
4. The facilitator verifies and settles it on Hedera testnet.
5. The gateway adds `5 × 10 = 50` credits to that key and writes a `credits_purchased` event to HCS.

Each Hedera transaction is credited once.

**Problems the user may hit (FAQ):**

| Message | Meaning |
|---|---|
| `401 invalid or revoked agent key` | wrong or revoked `GPUPOOL_API_KEY`: generate a new key |
| `hbar must be from 1 to 1000` | amount outside the limits |
| `402 …` after paying | the payment did not settle (no HBAR, wrong network, wrong key type): check the Portal account, then try again |
| `x402 is not configured on this gateway` | the gateway has no `X402_*` settings: ask the operator |
| a raw 64-hex private key | set `AGENT_KEY_TYPE=ecdsa` (Portal default) or `ed25519`, or use the DER key |

---

## Backend reference (all implemented)

| Call | Auth | Use on the docs page |
|---|---|---|
| `POST /agents {name, budget_mc?}` | session | block 1: **Generate API key** |
| `GET /agents` | session | block 2: the user's keys and their bought credits |
| `GET /me` | session | block 2: account credits |
| `GET /agents/:id/requests` | session (own key only) | block 2: usage (optional) |
| `DELETE /agents/:id` | session (own key only) | revoke (optional; `/keys` has it) |
| `GET /v1/models` | none | price, multiplier, pool context |
| `GET /v1/credits` | **API key only** (a session gets 403) | not on this page; used by `pnpm topup --check` and the user's own tools |
| `POST /v1/credits/topup {hbar}` | **API key** + x402 HBAR | not called by the page; `pnpm topup` calls it |
| `POST /v1/chat/completions` | API key | what OpenCode calls |

Schemas are in `shared/src/api.ts` (`AgentKey`, `AgentKeyCreateResponse`, `MeResponse`, `KeyCreditsResponse`, `CreditTopupRequest/Response`). Examples are in `shared/examples/`.

**Without the website:** the gateway operator can make keys with `cd gateway && pnpm api-key create --account acc_…` (see `docs/OPENCODE.md`).

---

## Acceptance checklist for the docs builder

- [ ] Signed out: no session calls; a "Sign in with World ID" button; the steps are readable.
- [ ] Signed in: "Generate API key" → the token is shown once with Copy, plus the OpenCode steps with the real gateway URL.
- [ ] The new key appears in "Your credits" without a page reload.
- [ ] Only this user's keys show. A second user signed in on another browser sees none of them.
- [ ] Account numbers match `GET /me`, and key numbers match `GET /agents` (credits = mc / 1000).
- [ ] The top-up steps show the rate and limits from `config.topup` and the testnet Portal and faucet links.
- [ ] Nothing on the page asks for or stores a Hedera private key. The API token is not saved in browser storage.
- [ ] After `pnpm topup --hbar 5`, a refresh shows +50 "Bought credits left" on that key.
- [ ] 390 px wide: no horizontal scroll (long commands wrap); axe has 0 violations.

## Verified (backend, 6 Nov 2026)

`cd gateway && pnpm e2e:docs` runs the whole flow over real HTTP:
- a fake Parallax and a fake x402 facilitator on localhost;
- the real gateway app;
- the real `agent-client` `topup` CLI signing a real Hedera transfer with a throwaway testnet key.

The run checks:

- not signed in → `POST /agents` is 401; signed in → 200 with a `gpa_agt_…` token;
- the key works as an OpenAI key: a streaming chat with tools returns `tool_calls` and `finish_reason: "tool_calls"`, and the gateway capped `max_tokens` 32000 to 2048;
- the cost is the actual tokens only (192.5 credits for 400 in / 30 out);
- `GET /agents` shows the key to its owner only; another user sees 0 keys and gets 404 on its usage;
- `pnpm topup --hbar 2` → the facilitator receives a signed transfer of 200000000 tinybar of HBAR to the treasury → +20 credits on the key; the account balance does not change;
- the next request takes 20 credits from the key first and 172.5 from the account (`request_settled.key_mc` = 20000);
- the ledger has `agent_key_created`, `credits_purchased` and `request_settled` events.

Unit tests: gateway `test/topup.test.ts`, `test/x402.test.ts` (top-up through the real x402 server), `test/api-key-script.test.ts`.

**Not done yet:** a payment on the real Hedera testnet with a real Portal account and the public facilitator. Run `pnpm topup --hbar 1` once against the live gateway.
