# agent-client (C9, TypeScript)

AI agent that pays each request with x402 (HBAR, Hedera testnet), with a budget cap. Prints HashScan links. Spec: `docs/SPEC.md` §13.

```bash
cp .env.example .env     # GATEWAY_URL, AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY (ECDSA), AGENT_BUDGET_HBAR
pnpm --filter @gpupool/agent-client start                       # 5 questions (SPENDS TESTNET HBAR)
node --env-file=.env src/agent.ts --questions 2 --max-tokens 128 --model Qwen/Qwen3-14B-FP8
pnpm --filter @gpupool/agent-client test                        # price tiers, budget cap, HashScan link (offline)
```

- No session token, so the gateway answers 402; `@x402/fetch` signs the HBAR transfer and retries.
- Budget: before each question the price comes from the shared config tier; the agent stops when `spent + price > AGENT_BUDGET_HBAR`. The x402 client is also capped per payment at the remaining budget.
- Each answer prints the settled tx (`PAYMENT-RESPONSE`), its HashScan link, and the receipt URL `GET /requests/:id`.

Live (6 Nov 2026, gateway on a fake pool): 2 questions, 0.02 HBAR each:
https://hashscan.io/testnet/transaction/0.0.9185802-1793930570-679764006 and
https://hashscan.io/testnet/transaction/0.0.9185802-1793930571-004892345 (both SUCCESS; HCS `x402_payment` seq 2 and 3).
