# World ID: Best Use of IDKit (GPU Pool)

**Track:** World, Best Use of IDKit, ETHGlobal Mumbai 2026 ($2500)
**Project:** GPU Pool. People pool their laptops to run AI models too big for any one machine. Requesters spend credits; contributors earn them.

---

## 1. IDKit in a working app
GPU Pool's web app uses **IDKit v4** (`@worldcoin/idkit`) for login, in a live product where laptops pool to run AI models.
The gateway signs each IDKit request on the server (`/auth/world/rp-signature`), so the signing key never reaches the browser.
## 2. Credential and server-side verification
We accept **Orb (`proof_of_human`) or Selfie Check (`selfie`)**. The browser forwards the proof unchanged to `/auth/world/verify`.
The gateway verifies it with **World's v4 verify API VIA Simulations** and stores the nullifier with a **unique constraint**: one account per human.
## 3. The product event that needs trust
Every new account gets **10,000 free starter credits** of AI inference, a scarce benefit paid for by real contributors.Logging in also unlocks **registering laptops that earn payouts**. Without proof of a unique human, one person could farm thousands of accounts or add fake nodes to skim payouts.People found having fake nodes are banned from the ervice 
## 4. Why this is the minimum sufficient credential

**Selfie Check is enough** to join and claim starter credits: the value at risk is small, it works on any phone or PC Simulation, and it doesn't shut out laptop owners who never visited an Orb.

## 5. Success path

A new human verifies, the gateway creates the account, and **10,000 starter credits** are granted.
The grant is written as a signed event to **Hedera HCS** (live run: HCS #8 and #9).

## 6. Alternative paths

- **Duplicate human (rejection of the benefit):** the same person verifies again, logs into the **same account**, sees **"Already registered"**, and gets **0 new credits**.
- **Cancellation:** closing the World ID window creates no account and changes nothing.
- **Wrong credential:** any result other than Orb or Selfie gets **HTTP 401**.

## 7. Integration debrief

- **Time to first success:** *2 seconds *. 
- **Friction:**
  - World's verify API returns **HTTP 200 for a reused nullifier** ("nullifier reuse"), so our own database constraint is the only duplicate guard.
  - The widget needed `any(proof_of_human, selfie)` explicitly.
  - The staging simulator returned the **same nullifier for every test identity**, so multi-user tests needed a dev script.
---

## Where it lives in the code

| Part | File |
|---|---|
| RP signature + verify handlers | `gateway/src/world.ts` |
| One account per nullifier, starter grant | `gateway/src/accounts.ts` |
| Credential tiers and node cap | `gateway/src/incentives.ts` |
| IDKit widget (`any(proof_of_human, selfie)`) | `frontend/src/auth/LoginSheet.tsx` |
| Spec | `docs/SPEC.md` §6 |
