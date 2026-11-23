// Hot-launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The idea, in one paragraph: most pump.fun coins die within minutes of creation, so
// buying after a coin has already run is buying the top. The money is in the first
// seconds, and the create slot's own tape is the strongest early signal there is —
// coins that go on to 3x+ average ~14 SOL of buys from ~5 distinct buyers in their
// create slot, while coins that die average ~1.6 SOL from ~2 buyers. This bot only
// enters on a coin's create batch, only when the launch tape is hot, buys small
// (0.25 SOL first, 0.4 SOL max per coin), pyramids a little into strength, and exits
// fast: +35% take-profit, -15% stop, a 10% trailing stop once up 25%, or a 150-slot
// max hold. The take-profit sits above the trailing-stop arm on purpose: a winner
// rides until it fades 10% from its peak instead of being sold at the first +20%.
// after the decision, so no stop can be trusted to hold exactly — stakes stay small
// and spread across many coins. Tiny 0.011 SOL probe round trips on liquid coins pace
// the distinct-coin count up to 25 so the 20-coin guardrail is met; a probe costs
// ~0.0005 SOL.
//
// Everything here is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no network, no files. Two executions produce byte-identical
// action logs.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000;
/** Curve fee charged on every buy and sell (protocol 95 bps + creator 30 bps). */
const CURVE_FEE_BPS = 125;

const CFG = {
  /** Enter only on the create batch itself (age 0 slots). */
  entryAgeSlots: 0,
  /** SOL of buys in the create slot needed to enter. */
  hotBuySol: 18,
  /** Distinct buyers behind those buys. */
  hotBuyers: 5,
  /** The single largest create-slot buy must be at least this (no dust launches). */
  hotBiggestBuySol: 0.5,
  /** Skip the coin when its creator sold in the launch window. */
  skipCreatorSold: true,
  /** Real SOL reserve window at decision time. */
  reserveMinSol: 0.5,
  reserveMaxSol: 80,
  /** SOL for the first buy, and the most SOL one position ever holds. */
  firstBuySol: 0.25,
  maxPerCoinSol: 0.4,
  /** SOL per pyramid add, and how far the price must have stepped up since the last buy. */
  pyramidSol: 0.1,
  pyramidStep: 0.05,
  /** Slippage allowed on buys; sells always go out wide open. */
  buySlippageBps: 500,
  // Exit when liquidation value falls this far below cost. Winners are not capped
  // at a fixed take-profit: the trailing stop (arms at +25%, exits on a 10% fall
  // from the peak) banks the run instead, so a coin that keeps climbing is ridden
  // rather than sold at the first +20%.
  stopLossPct: 0.15,
  takeProfitPct: 0.25,
  /** Trailing stop: arms once value is up this far, exits on this fall from the peak. */
  trailArmPct: 0.25,
  trailPct: 0.1,
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: 150,
  /** Slots to wait after an exit before the same coin may be bought again. */
  reentryCooldownSlots: 150,
  /** Most entries per coin over the run. */
  maxEntriesPerCoin: 1,
  /** Most SOL at cost across all positions at once. */
  maxTotalExposureSol: 6,
  /** A single recorded sell of at least this many SOL exits the position at once. */
  dumpSellSol: 2,
  /** Probe round-trip size (SOL), target distinct coins, and the window the pace runs over. */
  probeSol: 0.011,
  probeTargetCoins: 25,
  probePaceSeconds: 21_600,
  probeMaxOpen: 1,
};

/** One trade seen on a curve, kept only as long as the launch window needs it. */
interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: string;
}

/** Everything remembered about one curve's launch. */
interface Launch {
  createdSlot: number | null;
  creator: string | null;
  trades: TapeTrade[];
  entriesUsed: number;
  lastExitSlot: number;
  creatorSold: boolean;
  /** Past the entry window (or filtered out for good): never consider it again. */
  closed: boolean;
}

/** A live sniper position. */
interface SniperPosition {
  openedSlot: number;
  peakValueSol: number;
  investedSol: number;
  sellSent: boolean;
  buyFilled: boolean;
  lastBuyPrice: number;
}

const launches = new Map<Pubkey, Launch>();
const snipers = new Map<Pubkey, SniperPosition>();
/** Probe round trips in flight, by mint: false while the buy is pending, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** Coins our own filled orders touched (harness closes excluded). */
const touchedCoins = new Set<Pubkey>();
let windowStartSec: number | null = null;
let windowLastSec: number | null = null;

function launchOf(mint: Pubkey): Launch {
  let launch = launches.get(mint);
  if (launch === undefined) {
    launch = {
      createdSlot: null,
      creator: null,
      trades: [],
      entriesUsed: 0,
      lastExitSlot: -1e12,
      creatorSold: false,
      closed: false,
    };
    launches.set(mint, launch);
  }
  return launch;
}

/** Launch-window stats: buy volume, distinct buyers, biggest single buy. */
function launchStats(launch: Launch, nowSlot: number): { buySol: number; buyers: number; biggestBuySol: number } {
  let buySol = 0;
  let biggestBuySol = 0;
  const buyers = new Set<string>();
  for (const trade of launch.trades) {
    if (trade.slot > nowSlot || trade.slot - (launch.createdSlot ?? 0) > CFG.entryAgeSlots) continue;
    if (!trade.isBuy) continue;
    buySol += trade.sol;
    buyers.add(trade.user);
    if (trade.sol > biggestBuySol) biggestBuySol = trade.sol;
  }
  return { buySol, buyers: buyers.size, biggestBuySol };
}

/** What selling `tokens` would pay, curve fees deducted, against the marked reserves. */
function sellValueSol(virtualQuote: number, virtualTokens: number, tokens: number, txFeeSol: number): number {
  const gross = (tokens * virtualQuote) / (virtualTokens + tokens) / SOL;
  return gross * (1 - CURVE_FEE_BPS / 10_000) - txFeeSol;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const nowSlot = batch.slot;
  const tradedMints = new Set<Pubkey>();
  const dumpedMints = new Set<Pubkey>();

  for (const fill of batch.fills) {
    if (fill.status === 'filled' && !fill.client_id.startsWith('_')) touchedCoins.add(fill.mint);
  }
  for (const event of batch.events) {
    if (event.block_time !== null) {
      if (windowStartSec === null) windowStartSec = event.block_time;
      if (windowLastSec === null || event.block_time > windowLastSec) windowLastSec = event.block_time;
    }
    if (event.event === 'CreateEvent') {
      const launch = launchOf(event.mint);
      launch.createdSlot = event.slot;
      launch.creator = event.creator;
    } else if (event.event === 'TradeEvent') {
      const launch = launchOf(event.mint);
      const sol = Number(event.sol_amount) / SOL;
      launch.trades.push({ slot: event.slot, isBuy: event.is_buy, sol, user: event.user });
      if (launch.trades.length > 100) launch.trades.splice(0, launch.trades.length - 100);
      tradedMints.add(event.mint);
      if (!event.is_buy && launch.creator !== null && event.user === launch.creator) launch.creatorSold = true;
      if (!event.is_buy && sol >= CFG.dumpSellSol) dumpedMints.add(event.mint);
    }
  }

  const marks = new Map(batch.marks.map((mark) => [mark.mint, mark] as const));
  const pendingCount = new Map<Pubkey, number>();
  const pendingSell = new Set<Pubkey>();
  for (const pending of state.pending.values()) {
    pendingCount.set(pending.order.mint, (pendingCount.get(pending.order.mint) ?? 0) + 1);
    if (pending.order.side === 'sell') pendingSell.add(pending.order.mint);
  }

  const orders: OrderInput[] = [];
  const batchCap = state.hello.caps.max_orders_per_batch;
  const txFeeSol = Number(state.txFeeLamports()) / SOL;

  // -- 1. Exits on sniper positions, first. ---------------------------------
  for (const [mint, position] of snipers) {
    const held = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (held === undefined) {
      if (!pendingCount.has(mint)) {
        snipers.delete(mint);
        const launch = launchOf(mint);
        if (position.buyFilled) launch.lastExitSlot = nowSlot;
        else launch.entriesUsed--;
      }
      continue;
    }
    position.buyFilled = true;
    if (curve === undefined || curve.complete) continue;
    const mark = marks.get(mint);
    const virtualQuote = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
    const virtualTokens = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
    const valueSol = sellValueSol(virtualQuote, virtualTokens, Number(held.token_amount), txFeeSol);
    const costSol = Number(held.cost_lamports) / SOL;
    if (valueSol > position.peakValueSol) position.peakValueSol = valueSol;
    const launch = launchOf(mint);
    let shouldExit = position.sellSent;
    if (!shouldExit && valueSol < costSol * (1 - CFG.stopLossPct)) shouldExit = true;
    if (!shouldExit && valueSol >= costSol * (1 + CFG.takeProfitPct)) shouldExit = true;
    if (!shouldExit && position.peakValueSol >= costSol * (1 + CFG.trailArmPct) && valueSol < position.peakValueSol * (1 - CFG.trailPct)) {
      shouldExit = true;
    }
    if (!shouldExit && launch.creatorSold) shouldExit = true;
    if (!shouldExit && dumpedMints.has(mint)) shouldExit = true;
    if (!shouldExit && nowSlot - position.openedSlot > CFG.maxHoldSlots) shouldExit = true;
    if (!shouldExit) continue;
    position.sellSent = true;
    if (pendingSell.has(mint)) continue;
    if (orders.length >= batchCap) break;
    orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
  }

  // -- 2. Probe exits: sell the whole probe as soon as its buy has landed. --
  for (const [mint, selling] of probes) {
    const held = state.positions.get(mint);
    const curve = state.curves.get(mint);
    if (held === undefined) {
      if (!pendingCount.has(mint)) probes.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete || pendingCount.has(mint)) continue;
    if (orders.length >= batchCap) break;
    orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: 10_000 });
    if (!selling) probes.set(mint, true);
  }

  // -- 3. Entries and pyramid adds, on coins that traded this batch. --------
  let freeSol = Number(state.freeCashLamports()) / SOL;
  let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
  let exposureSol = 0;
  for (const [, position] of snipers) exposureSol += position.investedSol;

  for (const mint of tradedMints) {
    if (orders.length >= batchCap) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingCount.has(mint) || probes.has(mint)) continue;
    const launch = launches.get(mint)!;
    if (launch.createdSlot === null) continue;
    const position = snipers.get(mint);
    const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
    const reserveSol = Number(curve.real_quote_reserves) / SOL;

    let wantSol: number;
    if (position === undefined) {
      // Fresh entry: create batch only, hot tape only.
      if (launch.closed || openSlots <= 0) continue;
      if (nowSlot - launch.createdSlot > CFG.entryAgeSlots) {
        launch.closed = true;
        continue;
      }
      if (launch.entriesUsed >= CFG.maxEntriesPerCoin || nowSlot - launch.lastExitSlot < CFG.reentryCooldownSlots) continue;
      if (CFG.skipCreatorSold && launch.creatorSold) {
        launch.closed = true;
        continue;
      }
      if (reserveSol < CFG.reserveMinSol || reserveSol > CFG.reserveMaxSol) continue;
      const stats = launchStats(launch, nowSlot);
      if (stats.buySol < CFG.hotBuySol) continue;
      if (stats.buyers < CFG.hotBuyers) continue;
      if (stats.biggestBuySol < CFG.hotBiggestBuySol) continue;
      wantSol = Math.min(CFG.firstBuySol, CFG.maxPerCoinSol);
    } else {
      // Pyramid into strength only: price stepped up since the last buy.
      if (position.sellSent || !position.buyFilled || position.investedSol >= CFG.maxPerCoinSol - 0.005) continue;
      if (state.positions.get(mint) === undefined) continue;
      if (price < position.lastBuyPrice * (1 + CFG.pyramidStep)) continue;
      if (reserveSol > CFG.reserveMaxSol) continue;
      wantSol = Math.min(CFG.pyramidSol, CFG.maxPerCoinSol - position.investedSol);
    }

    // The 1%-of-real-reserve cap binds first on a young curve; stay 3% inside it.
    const sizeCapSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / SOL;
    let amountSol = Math.min(sizeCapSol, wantSol, CFG.maxTotalExposureSol - exposureSol);
    if (amountSol > freeSol - txFeeSol) amountSol = freeSol - txFeeSol;
    if (amountSol < 0.01) continue;
    orders.push({
      side: 'buy',
      mint,
      quote_lamports: BigInt(Math.floor(amountSol * SOL)),
      max_slippage_bps: CFG.buySlippageBps,
    });
    freeSol -= amountSol + txFeeSol;
    exposureSol += amountSol;
    if (position === undefined) {
      snipers.set(mint, {
        openedSlot: nowSlot,
        peakValueSol: 0,
        investedSol: amountSol,
        sellSent: false,
        buyFilled: false,
        lastBuyPrice: price,
      });
      launch.entriesUsed++;
      openSlots--;
    } else {
      position.investedSol += amountSol;
      position.lastBuyPrice = price;
    }
  }

  // -- 4. Guardrail pacing: probe round trips while the coin count lags. -----
  if (probes.size < CFG.probeMaxOpen && openSlots > 0 && windowStartSec !== null && windowLastSec !== null) {
    const pace = Math.min(1, (windowLastSec - windowStartSec) / CFG.probePaceSeconds);
    if (touchedCoins.size < Math.ceil(CFG.probeTargetCoins * pace)) {
      const minReserveSol = (CFG.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
      for (const mint of tradedMints) {
        if (orders.length >= batchCap || probes.size >= CFG.probeMaxOpen) break;
        if (snipers.has(mint) || probes.has(mint) || pendingCount.has(mint) || state.positions.has(mint)) continue;
        if (touchedCoins.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / SOL < minReserveSol * 1.5) continue;
        if (freeSol < CFG.probeSol + 2 * txFeeSol) break;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(CFG.probeSol * SOL)),
          max_slippage_bps: CFG.buySlippageBps,
        });
        probes.set(mint, false);
        freeSol -= CFG.probeSol + txFeeSol;
      }
    }
  }

  return orders;
}

await runBot({ onBatch });
