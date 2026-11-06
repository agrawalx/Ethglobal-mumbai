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
- **Price per token.** 1 credit is not 1 token. The price depends on the model (`model_factor`). A load multiplier is planned (Person 2, below); until it lands the multiplier is 1.

## What the gateway does for agent clients

| Problem | Fix | Where |
|---|---|---|
| OpenCode sends `tools`, `tool_calls`, `tool` messages and text-part arrays. The old schema dropped them. | The shared schema accepts them (`ChatMessage` union, `Tool`, `ToolChoice`, `ToolCall`). | `shared/src/api.ts` |
| Parallax has no native tool calling we can rely on. | `TOOLS_MODE=emulate` (default) works in four steps:<br>• tools are compacted and put into the system prompt in Qwen3's own format;<br>• earlier calls become `<tool_call>` text and results become `<tool_response>` turns;<br>• a streaming parser turns the model's `<tool_call>{…}</tool_call>` back into OpenAI `delta.tool_calls` with `finish_reason: "tool_calls"`;<br>• broken JSON gets one repair pass, and if that fails it is returned as text, never dropped.<br>`TOOLS_MODE=native` passes tools through unchanged. | `gateway/src/tools.ts` |
| The pool's context is small (4096 on Macs), and OpenCode resends the whole session each turn. | The gateway fits prompt + answer into the model's `context_length` (shared config, 4096 now) in this order:<br>1. compact the tools;<br>2. cut big tool results to head + tail;<br>3. drop the oldest turns, keeping the system prompt and the last user turn with its tool chain.<br>The `x-gpupool-trimmed` header gives the number of messages cut. If the prompt still does not fit, the response is 400 `context_length_exceeded` with the numbers. | `gateway/src/context.ts` |
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

## Still open (Person 2)

- Per-node `max_seq` in the heartbeat (`NodeHeartbeat.max_seq`), and the pool `context_length` = the minimum of its nodes. Until then the gateway uses `context_length` from `shared/config`.
- The floating price: a load multiplier of 0.5×–2×, locked per request, in `requests.price_multiplier`, `/v1/models[].price` (`PriceQuote`) and `x-gpupool-price`.
- The live end-to-end run with OpenCode, twice. Record request ids, HCS sequence numbers, multipliers and the picked `max_tokens` here.
