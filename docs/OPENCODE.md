# OpenCode on GPU Pool

People use [OpenCode](https://opencode.ai) with a GPU Pool API key. A prompt in OpenCode takes the
same path as a prompt in the website chat: the gateway, then the distributed pool (laptops on
Ethernet, Parallax), then back to OpenCode as a stream.

```
OpenCode ──POST /v1/chat/completions, Bearer gpa_…──▶ gateway
  key → account → fit context → pick max_tokens → hold → pick pool (Arkiv)
  ──▶ Parallax coordinator ──▶ layers over the laptops ──▶ tokens stream back
  gateway: <tool_call> text → OpenAI tool_calls → OpenCode; settle from usage → receipt + HCS event
```

## Setup (user)

1. Log in on the website with World ID. Every account starts with 10,000 credits.
2. Open **Keys** (`/keys`) and create a key. The token (`gpa_agt_…`) is shown once.
3. Run `export GPUPOOL_API_KEY=gpa_agt_…`.
4. Save the `opencode.json` shown on the Keys page in your project. It looks like this:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "gpupool": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "GPU Pool",
      "options": { "baseURL": "https://<gateway>/v1", "apiKey": "{env:GPUPOOL_API_KEY}" },
      "models": { "Qwen/Qwen3-14B-FP8": { "name": "Qwen3 14B on GPU Pool", "limit": { "context": 4096, "output": 2048 } } }
    }
  },
  "model": "gpupool/Qwen/Qwen3-14B-FP8"
}
```

5. Run `opencode` and pick the model with `/models`.

Any OpenAI client works the same way: use base URL `<gateway>/v1` and the key as the API key.

## Credits

- **What a key spends.** A key spends its account's credits, starter credits first, then earned credits. A key can have a cap (`budget_mc`); with no cap it can spend the whole balance. Revoking a key stops it at once (401).
- **How you earn more.** Serving the pool with your own laptop adds earned credits (the 90% node share, SPEC §8.3), and the key can spend those too.
- **What you pay for.** Only the tokens the pool ran: `cost = model_factor × (completion_tokens + 0.2 × prompt_tokens)`, taken from Parallax's `usage`.
  - The hold is only a reservation while the answer streams.
  - A failed or aborted request costs 0.
- **Price per token.** 1 credit is not 1 token. The price depends on the model (`model_factor`). The load multiplier floats from 0.5× to 2× and is locked per request (see Floating credit price below).

## What the gateway does for agent clients

| Problem | Fix | Where |
|---|---|---|
| OpenCode sends `tools`, `tool_calls`, `tool` messages and text-part arrays. The old schema dropped them. | The shared schema accepts them (`ChatMessage` union, `Tool`, `ToolChoice`, `ToolCall`). | `shared/src/api.ts` |
| Parallax has no native tool calling we can rely on. | `TOOLS_MODE=emulate` (default) works in four steps:<br>• tools are compacted and put into the system prompt in Qwen3's own format;<br>• earlier calls become `<tool_call>` text and results become `<tool_response>` turns;<br>• a streaming parser turns the model's `<tool_call>{…}</tool_call>` back into OpenAI `delta.tool_calls` with `finish_reason: "tool_calls"`;<br>• broken JSON gets one repair pass, and if that fails it is returned as text, never dropped.<br>`TOOLS_MODE=native` passes tools through unchanged. | `gateway/src/tools.ts` |
| The pool's context is small (4096 on Macs), and OpenCode resends the whole session each turn. | The gateway fits prompt + answer into the pool's live context: the smallest `max_seq` its fresh nodes report (`router.contextLength`, cached 10 s). When any pool has not reported one, or Arkiv fails, it falls back to `context_length` in shared config (4096 now). Steps:<br>1. compact the tools;<br>2. cut big tool results to head + tail;<br>3. drop the oldest turns, keeping the system prompt and the last user turn with its tool chain.<br>The `x-gpupool-trimmed` header gives the number of messages cut. If the prompt still does not fit, the response is 400 `context_length_exceeded` with the numbers. | `gateway/src/context.ts` |
| OpenCode asks for `max_tokens` 32000, so the hold would fail every time. | For credit requests the gateway picks the answer cap:<br>`min(model max, room left in the context, learned need, what the balance pays)`<br>• the learned need is the p90 of the user's (or key's) last 50 answers × 1.25, at least 256;<br>• an answer that was cut off doubles the next cap.<br>The `x-gpupool-max-tokens` header gives the cap. A 403 comes only when the balance cannot pay 64 tokens. x402 requests keep the per-tier limit (400 above 2048). | `gateway/src/budget.ts`, `billing.ts` |

## Errors OpenCode can see

| Status | Code | Meaning |
|---|---|---|
| 401 | `unauthorized` | The key is wrong or revoked. A key never falls through to x402. |
| 403 | `insufficient_credits` | The balance (or the key's cap) cannot pay a 64-token answer. |
| 400 | `context_length_exceeded` | The prompt does not fit even after trimming. Start a new session or compact it. |
| 503 | `no_pool_available` | No ready pool. Retry after `Retry-After`. |

## Endpoints

- `POST /agents {name, budget_mc?}` creates a key. `GET /agents` lists keys, with `last_used_at`. `DELETE /agents/:id` revokes one.
- `GET /agents/:id/requests` returns the key's last 50 requests (tokens, picked `max_tokens`, cost, HCS sequence).

## Verified so far (offline, 6 Nov 2026)

- shared: 60 tests. gateway: 166 tests, including a full OpenCode turn against a fake Parallax:
  - the tool call goes out;
  - Parallax sees plain text only;
  - the result comes back as `<tool_response>`;
  - the charge is exact;
  - keys pass the same checks: spend, revoke → 401, wrong key → 401, cap → 403.
- frontend: 81 checks plus live-adapter checks. A browser run of `/keys` against fixture responses covered create, copy, usage, receipt and revoke at 1440 and 390 px, with axe at 0.
- **Not live evidence.** Nothing here has run against the real pool or a real OpenCode client yet.

## Pool measurements (Person 2)

To be filled from the live pool:
- whether Parallax keeps `tools` (sets `TOOLS_MODE`);
- the largest safe `--max-sequence-length` per node;
- prefill and tok/s at 4k, 8k and 16k tokens.

## Person 2 status

Local implementation on `api`: signed heartbeat `max_seq`, fresh-node pool context
minimum, Arkiv pool `context_length`, `/v1/models` context and price, and locked
floating credit prices. These changes do not certify a live pool run.

## Pool measurements

Pending hardware access. This checkout has no Parallax coordinator listening on
`127.0.0.1:3001`, no pool runtime state, and no agent bridge at the path in HANDOFF.
The historical results in HANDOFF are not new measurements for this task.

The following must be measured directly against the coordinator, bypassing the gateway:

- Native tools: whether definitions survive and responses contain `tool_calls`, raw
  `<tool_call>` text, or neither. Keep the current `TOOLS_MODE` until this is measured.
- M4 16 GB, M5 16 GB and 4060 8 GB: 8192, 12288 and 16384 sequence lengths, with
  the KV fraction and assigned layers recorded. Observe macOS `vm.swapusage`
  before and during inference; record CUDA memory on the 4060.
- Actual 4096, 8192 and 16384 prompt tokens: prefill latency and generation tokens/s.

Do not raise the known-good Mac sequence limit before these measurements. The
memory formula and automatic launch limit remain pending calibration against
usable memory, assigned weight memory, runtime overhead, and KV bytes per token
for each assigned layer. No measured constants have been invented.

`pool/lib.sh` records an explicit `--max-sequence-length` in the current process's
log. The agent signs that value as `max_seq`; a restart clears it. An unknown
runtime limit stays unknown. The gateway excludes stale and offline heartbeats
from the minimum. If a fresh member has no limit, the optional pool/model context
is omitted so the request-path config fallback can apply.

## Floating credit price

Quotes begin at 1×. Each model's quote refreshes lazily on the first read after
30 seconds. The multiplier is `clamp(0.5 + 0.5 × (active + queued), 0.5, 2)`.
Idle demand therefore costs 0.5×, one request 1×, and three requests 2×.
Input weight remains 0.2; model factors and the 90/5/5 split are unchanged.

`/v1/models[].price` contains credits per 1000 input/output tokens, the multiplier,
and the quote timestamp. `/v1/chat/completions` locks a quote before waiting for
a pool slot, returns it as JSON in `x-gpupool-price`, and stores its multiplier
in `requests.price_multiplier`. Credit holds and actual-usage settlement use
that locked multiplier, including across retries and load changes. Charges never
exceed the hold. The signed `request_settled` HCS event includes the multiplier.
x402's existing fixed HBAR tiers are unchanged: x402 requests get no `x-gpupool-price` header and store no multiplier (the receipt shows null).

SQLite schema is 15. Use a fresh development database. No live database was changed.

Person 1 integration points: `router.pricing.quote(model)` gives a copy of the current
quote; `SelectedPool.context_length` gives that pool's optional runtime limit; `router.contextLength(model)` (the minimum over ready pools) now drives context fitting in `chat.ts`, and the Keys page shows the live price, multiplier and pool context from `/v1/models`, falling back to config.
`holdMc` and `costMc` take an optional final multiplier (default 1). The existing
billing path locks and passes the multiplier to settlement and affordability budgeting.
Person 1's Keys page, per-user budgeting and context fitting are integrated from `origin/api`.

Verification after integration: `pnpm --filter @gpupool/gateway test` (171 passed),
`pnpm --filter @gpupool/shared --filter @gpupool/arkiv test` (60 + 10 passed),
and gateway/shared/Arkiv `typecheck` passed. Node-agent pytest passed 24 tests;
`bash -n pool/lib.sh pool/join-node.sh` and `git diff --check` passed.
The test suites needed permission to bind local fixture ports and run subprocesses
outside the sandbox. No live pool was used.

## Live end-to-end evidence

Pending pool access and live verification of the integrated Keys page, context fitting
and per-user budget work. No live runs have been claimed. Run the acceptance sequence
twice after integration: fresh World login, key creation, OpenCode tool/result/answer,
exact receipt/balance reconciliation, three parallel clients, long-session trimming,
provider earnings, drain to 403, and revoked-key 401.

Record request IDs, HCS sequence numbers, locked multipliers and picked `max_tokens`
here for both runs. Never record API keys. Use Hedera testnet only.
