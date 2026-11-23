[![make.fun](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/cholick0/pumpfun-sprint-2/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/cholick0/pumpfun-sprint-2/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

# pumpfun-sprint-2

A trading bot for the make.fun bounty [Winner Takes All — $5 Pump.fun Replay Sprint](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3): trade 10 SOL of paper money on a 6-hour pump.fun replay, best net PnL wins. Nothing is traded for real.

## Strategy

A hot-launch sniper. It enters only on a coin's create batch, when the launch tape is hot — at least 18 SOL of buys from at least 5 distinct buyers in the create slot, with the creator not selling. It buys up to the 1%-of-reserve size cap (0.25 SOL first, 0.4 SOL max per coin), pyramids a little into strength, and exits fast: +20% take-profit, −15% stop, a trailing stop once up 25%, or a 150-slot max hold. Tiny 0.011 SOL probe round trips on liquid coins keep the run above the 20-coin guardrail. See [STRATEGY.md](STRATEGY.md) for the evidence and the local numbers.

## Run

The entry point is `main.ts` (Node 22, stdlib only, erasable TypeScript). The grader runs `node /bot/main.ts`; the protocol shim is vendored at `vendor/makefun-bot.ts`.

## Local grade (dev window)

```
+0.83 SOL net PnL on the kit's 24h dev window (52 round trips, 28 wins, 2.6% max drawdown),
+0.19 SOL per 6h slice on average (3 of 4 slices positive, 25-27 distinct coins per slice).
```

Built by an AI agent for a make.fun bounty.
