# GPU Pool: frontend

The web app for the GPU Pool Network MVP (spec v0.1 §12). It has the landing page with World ID login, the chat playground, the account page (where node owners link their nodes), the network directory from Arkiv, the HCS ledger, and HBAR payouts.

Vite 8 · React 19 · TypeScript 7 · plain CSS · `motion` for the scroll story · three.js for the hero · wagmi + viem (Hedera testnet) · World ID IDKit v4.

## Run it

```bash
npm install
cp .env.example .env.local    # optional: mock mode needs no config
npm run dev                   # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Dev server. Proxies the gateway paths (`/v1`, `/auth`, `/me`, `/nodes`, `/requests`, `/network`, `/ledger`, `/payouts`) to `VITE_GATEWAY_URL` |
| `npm run build` | Type-check (`tsc -b`) and production build to `dist/` |
| `npm run preview` | Serve `dist/` with the same proxy |
| `npm run lint` | oxlint |
| `npm test` | Money and data-layer checks (`tests/data.test.mts`, plain Node via tsx): cost, hold, 90/5/5 split, self-request rule, starter-first spending, ratio, x402 prices, mock chat, claims |

Node 24 or newer.

`/network`, `/ledger` and `/payouts` are both app pages and gateway paths. The proxy sends a browser page load (`Accept: text/html`) to the app and everything else to the gateway. On Vercel, `vercel.json` rewrites every path without a file extension to `index.html`.

## Mock and live data

Every page reads through one `PoolApi` interface (`src/data/api.ts`).

- **`VITE_DATA_MODE=mock`** (default): seeded fixtures and a 1 s ticker (`src/data/mock/`). Everything works offline, and state lasts for the browser tab (sessionStorage). The header shows a **mock data** badge. HashScan links are off, because every id is synthetic.
- **`VITE_DATA_MODE=live`**: the gateway (spec §5.2) and the Hedera mirror node (`src/data/live/`). If a public read (`/v1/models`, `/requests/:id`, `/network`, `/ledger/events`, `/payouts/:address`) is not up yet (404, network error, 5xx), that one call falls back to mock and the header shows a **mock fallback** badge. Login, `/me`, chat, node registration, the mirror check and claims **never** fall back.

## Environment

Everything in `VITE_*` ships to the browser. **Never put private keys, the World RP signing key, the gateway signing key, or Hedera or Arkiv keys here.**

| Variable | Used for |
|---|---|
| `VITE_DATA_MODE` | `mock` or `live` |
| `VITE_GATEWAY_URL` | Gateway base. Empty means same origin through the proxy |
| `VITE_WORLD_APP_ID` | World ID app id (`app_…`). The IDKit widget opens only when this is set **and** the gateway returns a signed RP context from `/auth/world/rp-signature` |
| `VITE_WORLD_ACTION` | World ID action, default `gpupool-account` |
| `VITE_HEDERA_RPC` | Hedera testnet JSON-RPC (chain 296), default Hashio |
| `VITE_PAYOUT_ADDR` | `EpochPayout.sol`, for claims on `/payouts` |
| `VITE_HCS_TOPIC` | The ledger topic, for HashScan links and the mirror check |
| `VITE_MIRROR_URL` | Hedera mirror node REST base, default testnet |

Put your World ID app id in `.env.local` (`VITE_WORLD_APP_ID=app_…`). Without it, mock mode offers simulated login outcomes and live mode says that World login is not available.

## Routes

History API routing (`src/lib/router.ts`). Old `#/…` links are upgraded. A hash without a slash (`/#how-it-works`) is an anchor on the landing page.

| Route | Page | Reads |
|---|---|---|
| `/` | Landing: particle hero, crew, the "How it works" scroll story (install → World login → model split → Arkiv listing → request → credits → HBAR payout). The hero CTA opens World login, then `/chat` | none |
| `/chat` | Playground. Logged in: balance, model picker (Arkiv), hold estimate, streamed reply, route trace, receipt with the split. Logged out: World login, the API and x402 prices | `/v1/models`, `/v1/chat/completions`, `/requests/:id`, `/me` |
| `/account` | Balance (starter with expiry, earned, held), contribution ratio, payout address, my nodes (≤ 3) with reliability, recent receipts. `?register=…` opens the Confirm node card | `/me`, `/nodes/register`, `/ledger/events`, `/requests/:id` |
| `/network` | Pool listing with its layer map, node listings with 120 s expiry rings, models, contributors (`gpupool.account_stats`) | `/network`, `/v1/models` |
| `/ledger` | Ledger events, filter by type (`?type=`), pages of 25. Open a row to see the payload and check it on the mirror node | `/ledger/events`, mirror node |
| `/payouts` | Wallet gate, current epoch countdown, your payouts with Claim, epochs with Merkle roots | `/payouts/:address`, `EpochPayout.claim` |

Console routes are lazy-loaded (`src/ConsoleRoot.tsx`), so the landing page does not download wagmi or IDKit.

## Node registration link

`gpupool-node init` must print a link in this format. The frontend reads it on `/account`:

```
https://<app>/account?register=<node_id>&gpu=<gpu name>&mem=<GB>&sig=<signature>
```

| Param | Meaning |
|---|---|
| `register` | Node id: the EVM address of `~/.gpupool/node.key` (`0x` + 40 hex) |
| `gpu` | GPU name, URL-encoded (for example `RTX%204060%20Laptop`) |
| `mem` | Memory in GB |
| `sig` | The node key's signature, checked by the gateway |

If the user is logged out, the link survives the World login. Confirm sends `POST /nodes/register` with `{ node_id, sig, gpu, mem_gb, payout_address }`. The payout address comes from the connected wallet, unless the account already has one. The gateway refuses a 4th node.

## Demo script (mock mode)

The 9 steps of spec §1.1, with the mock hooks:

1. **Open the app.** Go to `/` and scroll through "How it works".
2. **Log in with World ID.** Use the hero CTA, or "Log in with World ID" on `/chat`. In mock mode, pick **New human**: "Welcome. 10,000 starter credits." (Pick **Same human again** to show "Already registered", with no new credits.)
3. **Select a model.** `/chat` lists the models from Arkiv: Qwen3-14B-FP8 (×1.75) is served, and Qwen3-8B shows "no live pool".
4. **Send a prompt.** Ask "How does the pool split one model across laptops?" The route lights Rex → Mika → Nova as tokens stream.
5. **Route, cost, balance.** The receipt badge shows the cost, the new balance and the HCS sequence number. Open it to see the split: 90% by layers, 5% burn, 5% reserve.
6. **The ledger event.** `/ledger` shows the new `request_settled` at the top. Open it: "✓ on HCS #…" from the mirror check.
7. **An agent pays with x402.** Logged out, `/chat` shows the x402 agent snippet (402 → pay → retry) and the prices. The ledger has `x402_payment` events. (The real client is in `agent-client/`.)
8. **Node owners.** `/network` shows each node's reliability and the contributors table with credits earned. On `/account`, open a registration link to link a node (up to 3).
9. **Epoch payout.** `/payouts`, then **Use the demo wallet** (it is Mika's payout address). Epoch 11 is posted: **Claim**. The row turns "claimed" with a transaction, and `/ledger` shows `payout_claimed`.

**Unplug a laptop.** In the browser console, run `__gpupoolUnplug("Rex")`. Its listing stops renewing, and within 120 s its card disappears from `/network` and the pool turns "forming". `__gpupoolExpireNow("Rex")` does it at once, and `__gpupoolReplug("Rex")` brings it back.

## Layout

```
src/
  App.tsx, ConsoleRoot.tsx    routing; console routes lazy-loaded
  auth/                       World login session (sessionStorage token) and the login sheet
  pages/                      Landing, Chat, Account, Network, Ledger, Payouts, NotFound
  components/                 landing pieces (from quil), Icon, SourceBadge
    story/                    the pinned scroll story
    chat/ network/ console/
  data/                       PoolApi, mock/, live/, fallback wrapper
  wallet/                     wagmi config (Hedera 296), useWallet, demo wallet
  abis/                       EpochPayout (placeholder from spec §10.5)
  lib/                        credits (spec §7.3, §8), format, links, router
  hooks/ config/ styles/
../shared/ts                  types shared with the gateway, imported as @shared/*
```

## Notes for the backend team

These are open questions in spec v0.1. The frontend works either way.

1. **§10.2 example.** The HCS example says in 412 / out 256 / cost 490. The §8.1 formula gives 1.75 × (256 + 0.2 × 412) = 592.2. The tests follow the formula and the §8.3 split.
2. **Orb or Selfie Check.** v0.1 allows both, but the repo `CLAUDE.md` says selfie only. The login uses `any(proof_of_human, selfie)`.
3. **`gpupool.account_stats`.** §11.2 says the frontend reads it, but §12 has no page for it. It is the Contributors table on `/network`.
4. **No list-receipts endpoint.** §5.2 has `/requests/:id` only. In live mode, `/account` finds the account's `request_settled` events in `/ledger/events` and reads each receipt.
5. **x402 header.** §7.2 does not name the payment header. The agent snippet uses `X-PAYMENT` (the x402 default).
6. **Payout address.** §5.2 has no endpoint to set it on its own. The frontend sends it with `/nodes/register`.
7. **`EpochPayout` ABI.** `src/abis/EpochPayout.ts` follows the §10.5 interface. Replace it with the compiled ABI when the contract is in `contracts/`.

## Honesty notes

- The first laptop in the pipeline sees prompts in plain text. The privacy page (`public/privacy.html`) says so.
- HCS gets hashes of the prompt and the reply, never the text. The gateway keeps the text for 7 days.
- In mock mode every id, hash and transaction is synthetic, and the UI labels it that way.

## Credits

Based on [quil](https://github.com/ELLA0VICTOR/quil) by ELLA0VICTOR (MIT, see `LICENSE` and `NOTICE.md`). The scroll story is adapted from the docs page of [omniverse](https://github.com/vihaan1016/omniverse) by vihaan1016.
