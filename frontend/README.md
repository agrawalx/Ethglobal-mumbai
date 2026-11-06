# GPU Pool live frontend

Vite/React frontend copied from origin/main and integrated against backendXoutofscope shared Zod schemas. Runtime data always comes from the gateway/mirror node. No runtime fixture fallback, simulated login or seeded wallet is enabled. Fixtures remain for offline tests only.

Run `pnpm install` at workspace root, then `pnpm --dir frontend dev`. Build: `pnpm --dir frontend build`. Tests: `pnpm --dir frontend test` and `pnpm --dir frontend test:live`. Public configuration is documented in `.env.example`. RP context comes from the gateway. Claim uses the identical V1/V2 claim selector and waits for a successful receipt; gateway proofs determine availability.

See `../docs/LIVE-DEMO-RUNBOOK.md` for real hardware/service acceptance and remaining operator tasks. Source artwork is illustrative, not telemetry. Keep LICENSE and NOTICE attribution.
