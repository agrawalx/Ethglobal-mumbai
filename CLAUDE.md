# CLAUDE.md: Rules for agents in this repository

## 0. Read first

1. `docs/HANDOFF.md`: context, what is already proven, environment, implementation plan, env keys.
2. `docs/SPEC.md`: MVP specification. **Source of truth for behaviour.**
3. `docs/PROPOSAL.md`: the pitch. Read it to understand why, not what to build.
4. `docs/research/`: background only. It is **not** a requirement.

If these documents conflict, `docs/SPEC.md` wins. If the spec is unclear or wrong, stop and ask. Do not guess.

---

## 1. Project phase

- We are in the **development phase** of a hackathon MVP (ETHGlobal Mumbai 2026).
- **No backward compatibility is needed.** No users, data, or deployed clients need to be preserved.
  - Change or delete APIs, schemas, database tables, file layouts, and config keys freely.
  - Do not write migrations, shims, deprecation paths, version flags, or compatibility layers.
  - If a schema changes, drop and recreate the SQLite database.
  - When you change a shared interface, update **all** users in the same change.
- Speed and a working demo matter more than generality.

---

## 2. Scope rules (do not steer away)

1. **The MVP (`docs/SPEC.md` §1–§15) is complete.** The team also built most post-MVP items in `docs/SPEC.md` §16 on purpose (user decision, 6 Nov 2026). §16 gives the status of each item.
2. **Output verification (§16.2) is disabled** (`VERIFICATION_ENABLED=false`) and will be designed again later. Do not turn it on, extend it, or build on its draft code (`gateway/src/verification.ts`) unless the user asks.
   - Still out of scope: Postgres, multiple gateways, speculative decoding, any change inside Parallax (runtime hooks in `pool/hooks/` are allowed).
   - Live-test the §16 features before you rely on them; many have unit tests only.
3. **Do not design against planned items.** Keep the data that the spec says to keep (hashes, routes, transcripts).
4. **No new features, abstractions, or "improvements"** that the current task does not need. No plugin systems, no generic frameworks, no premature configuration.
5. **Work on one task at a time.** Each task maps to a step in `docs/HANDOFF.md` §5. Finish it, meet its "done when", then stop and report.
6. If you think the spec should change, **propose** the change and wait for approval. Do not change scope on your own.

---

## 3. Architecture rules (fixed decisions; do not reopen)

| Decision | Rule |
|---|---|
| Distributed inference | **Parallax** as an installed dependency. **Never fork it into this repo.** Runtime wrappers and scripts go in `pool/`. |
| Gateway | One TypeScript service (Node 24, Hono or Fastify). The only public entry point. |
| Database | **SQLite** (`better-sqlite3`). Postgres is out of scope. |
| Identity | World IDKit v4, action `gpupool-account`, credentials **Orb** or `selfieCheck` (either one). One account per nullifier (TEXT UNIQUE). |
| Payments | Credits for accounts; **x402 (HBAR on Hedera testnet)** for requests without a session. |
| Ledger | SQLite is the working copy. **Every balance change also goes to HCS.** |
| Payouts | x402 income → HBAR payouts per epoch via `EpochPayout.sol` (Merkle claim). No vesting, no disputes. |
| Directory | **Arkiv** for nodes, pools, models, account stats. Node registry lives in Arkiv, not in a contract. |
| Router | Model → pool, from Arkiv pool listings. Score = reliability × (1 − load). Parallax picks nodes inside the pool. |
| Reputation | Reliability only (success 0.7 + uptime 0.3). No credit penalties. |
| Incentives | Credit formula, 90/5/5 split, self-request rule, starter credits: `docs/SPEC.md` §8. Do not invent new rules. |

---

## 4. Code rules

1. Keep code simple and direct. Prefer a plain function over a class hierarchy.
2. Use the types in `shared/` for every cross-component interface. If an interface changes, change `shared/` first, then all users.
3. Configuration comes from `.env`. Every new key must also go into the matching `.env.example` and `docs/HANDOFF.md` §8.
4. No hard-coded secrets, IPs, or keys in code. IPs change at the venue.
5. Handle errors at the boundaries (HTTP, Parallax, Hedera, Arkiv, World). Return clear errors. Do not swallow errors.
6. Write tests for money logic: cost calculation, split, hold/settle, Merkle proofs, contract claims. Other code: test the happy path and one failure path.
7. Hedera EVM: `msg.value` is in **tinybars** inside the contract. Test the units.
8. Do not write to Arkiv per request (blocks are ~2 s). Follow the write rates in `docs/SPEC.md` §11.4.
9. Do not block a user request on HCS or Arkiv writes. Write asynchronously.

---

## 5. Security rules (never break these)

1. **Never commit secrets:** `.env`, keys, `p2p.key`, `node.key`, World RP signing key, Hedera private keys, Arkiv keys.
2. **Never** put a private key or the World RP signing key in a `VITE_*` (browser) variable.
3. The Parallax API (port 3001) **stays on `127.0.0.1`**. Only the gateway calls it. It has no auth and an open `/weight/refit`.
4. Always run Parallax with `-u`, a private `--dht-prefix`, fixed ports, and `--announce-maddrs`.
5. Do not open firewall ports to the whole venue network. Allow only pool member IPs.
6. Do not weaken SSH (keys only; restricted bridge key).
7. Use Hedera **testnet** only.

---

## 6. Operating rules (Parallax and the pool)

1. Start Parallax with `setsid`. Stop it by **process group**. After a stop, `pgrep -f "parallax/.venv/bin/python"` must be empty. (Leftover children become ghost nodes.)
2. Start all node joins **within 30 seconds** of each other. A slow joiner is dropped at placement.
3. Download models **before** a node joins. Nodes use `HF_HUB_OFFLINE=1`. The scheduler does **not**.
4. Mac nodes use `--kv-cache-memory-fraction 0.25 --max-sequence-length 4096`.
5. Never send `logprobs` to Parallax. Send `"chat_template_kwargs": {"enable_thinking": false}` unless the user asks for thinking.
6. Use the known-good commands in `docs/HANDOFF.md` §3.1. Do not invent new flags without a reason.
7. Do not run long benchmarks or tuning loops unless the task asks for them.

---

## 7. Collaboration rules

1. Mac work goes through the agent bridge: `~/agent-bridge-src/agent-bridge/bridge send --to codex --kind task --key <TASK-ID> '...'`. Include the task ID, the exact commands, and the acceptance criteria.
2. Do not run commands that need sudo yourself. Ask the user to run them with `!`.
3. Do not commit or push unless the user asks. Do not force-push. Do not rewrite shared history.
4. Commit messages: short, imperative, one change per commit.
5. When you finish a task, report: what changed, how you verified it (command + output), and what is next. Say clearly if something is not verified.
6. Ask before any action that is hard to undo or affects other people (pushes, deleting data, spending real tokens, changing firewall or SSH).

---

## 8. Definition of done (for any task)

- The "done when" check in `docs/HANDOFF.md` §5 passes, and you show the evidence.
- Tests for money logic pass.
- `.env.example` and docs are updated if keys or behaviour changed.
- No secrets in the diff (`git diff --cached` checked).
- No out-of-scope code was added.


Never write co-authored-by Claude line in the commit messages and make short 1 line commit messages only