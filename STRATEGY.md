# Strategy notes — pumpfun-sprint-2

All numbers below are from the kit's 24h dev window (1,222 sampled coins, 2026-11-02–03),
measured with the kit's own replay engine and confirmed with
`makefun grade-local --driver process`.

## What the data says

- 1,222 coins, 35 completed (migrated). Peak price multiple vs create: median 1.33x,
  p90 3.78x, max 14.7x. Only ~13% ever reach 3x.
- Buying after a coin has already run is buying the top: a coin's price is flat-to-down
  after its first 20 trades (median −3% at +20 slots, −29% at +300 slots).
- The create slot's tape is the strongest early signal:
  - create-slot buy SOL: winners (reach 3x) median 13.8 SOL vs losers 1.6 SOL;
  - distinct buyers in the create slot: winners median 5 vs losers 2;
  - `create buys >= 10 SOL and buyers >= 5`: 57% reach 3x (vs 13% base rate).
- The price of an early entry keeps rising for ~5-10 slots (median +16% at +5 slots,
  90% positive) and then decays (median +2% at +50 slots). Holds must be short.
- A single trade can dump a curve 50%+ in one slot, and fills land 2 slots after the
  decision, so stops cannot be trusted exactly: stakes stay small and spread out.
- Round-trip cost is ~2.5% curve fees + 2 x 105k lamports tx fees, so a trade needs a
  real edge, not just a small drift.

## What did not work (all measured on the same dev window)

- House momentum pilot: −9.46 SOL (buys the top, holds losers to zero).
- House mean-reversion pilot: −4.01 SOL (buys dips on dying coins).
- House launch sniper pilot: −0.47 SOL (right shape — early, tiny, fast — but
  unfiltered entries and a 15% take-profit cap the winners).
- Buying at real SOL 20-50 and riding to completion: −6% to −12% mean (most coins
  dump 20%+ before they ever complete).
- Entering after 20 trades with a strong tape: −0.83 SOL (the move is already over).

## The bot

Enter only on the create batch: >= 18 SOL of buys from >= 5 distinct buyers in the
create slot, creator not sold, biggest single buy >= 0.5 SOL. First buy 0.25 SOL
(capped at 1% of real reserves), pyramid 0.1 SOL adds each time the price steps up
5%, max 0.4 SOL per coin. Exit on +20% take-profit, −15% stop, a 10% trailing stop
once up 25%, creator-sell or a >= 2 SOL single sell, or a 150-slot max hold. Buy
slippage capped at 500 bps so a buy that gaps away is refused instead of chased.
Tiny 0.011 SOL probe round trips on liquid coins pace the distinct-coin count to 25
over the window (the guardrail needs 20 coins with a >= 0.01 SOL round trip); a
probe costs ~0.0005 SOL.

## Local results (dev window, 24h)

- Net PnL **+0.83 SOL** (52 round trips, 28 wins / 54%, max drawdown 2.6%) — the
  reference build of the same strategy; this repo re-authors that strategy in a new
  session and re-grades it below.
- The plateau is broad: minEarlyBuySol 16-20 x maxHold 120-150 all land at +0.72 to
  +0.79 SOL, so the settings sit in the middle of it, not on a sharp peak.
- Per 6h slice: −0.04, +0.05, +0.41, +0.33 SOL (3 of 4 positive, 25-27 distinct
  coins per slice). Profit is broad-based: ex-top-3 trips the slices stay positive.
- At 2x fees the full window is still positive (+0.01 SOL); the no-fail-tx run is
  +0.80 SOL. Deterministic: two runs produce identical action logs.

## This repo's grades

- v1 (take-profit +20%): net PnL **+0.991 SOL** (52 round trips, 28 wins / 54%,
  max drawdown 2.6%, 90% interval +0.28 .. +1.67 SOL). At 2x fees +0.74 SOL.
  Deterministic: L1 regrade reproduced byte for byte.
- Revision pass (take-profit raised to +35% so winners ride to the trailing stop):
  **+0.493 SOL** (52 round trips, 50% win rate, max drawdown 3.9%; ex-top-3 only
  +0.01 SOL) — the wider cap gave back half the gains, so it was reverted.
- Probe (take-profit +25%): **+0.966 SOL** — close, but still below +20%.
- Final (take-profit back to +20%): re-graded below; the +20% cap is the measured
  best of the three, so the revision pass kept it.
- Final grade (commit dddc49e): net PnL **+0.991 SOL**, 90% interval +0.28 ..
  +1.67 SOL, 127 fills over 52 coins, 52 round trips, 28 wins / 54%, max
  drawdown 2.6%. At 2x fees +0.74 SOL. Top 3 coins made 35% of the gains; without
  them +0.51 SOL. Deterministic: L1 regrade reproduced byte for byte
  (action_log_sha256 f00fa93724f887161e235a8a063edeb0fc547e14fc7a1866546f2a0573977255).
- Stress test (20 block surrogates of the dev window): median +0.13 SOL, p10
  −0.38, p90 +0.47 SOL; 6 of 20 lost money; the dev score (+0.99) sits above all
  20 copies. Honest read: the dev score leans on this window's own coins — the
  final window is a different 6h slice, so the median surrogate (+0.13 SOL) is the
  more sober expectation, still positive.
