// Tiny Bot — oversold-bounce trader on Solana 1h bars (agent-fun/bars-replay/v1).
//
// Idea (original): in a choppy, mostly falling tape the edge is not chasing
// trend but buying panic. A symbol is bought only when its 14-bar RSI falls
// under 25 (deeply oversold), sized to at most 25% of equity, and sold when
// it bounces (+6% take-profit), when the panic deepens instead (-4% stop),
// or when momentum normalises (RSI back above 55). No shorts, no leverage,
// no network, no clock, no randomness: every decision is a pure function of
// the replayed closes, so two runs are byte-identical.
import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

// --- tuning (chosen on the dev window, kept generic, not curve-fit) ---
const RSI_PERIOD = 14;
const RSI_BUY = 25; // deeply oversold
const RSI_EXIT = 55; // momentum normalised
const TAKE_PROFIT = 0.06; // +6% from filled cost
const STOP_LOSS = -0.04; // -4% from filled cost
const MAX_WEIGHT_BPS = 2500n; // 25% of equity per symbol (harness cap)
const MIN_BUY_USDC = 10_000_000n; // $10 in micro-USDC
const MAX_SLIPPAGE_BPS = 300;

// --- per-symbol close history, built bar by bar from the replay ---
const closes = new Map<string, number[]>();

function recordCloses(state: BarsState): void {
  for (const [symbol, bar] of state.latest) {
    const priceScale = state.symbols.get(symbol)?.price_scale ?? 0;
    const close = Number(bar.c) / 10 ** priceScale;
    let list = closes.get(symbol);
    if (list === undefined) {
      list = [];
      closes.set(symbol, list);
    }
    const last = list[list.length - 1];
    if (last !== close) list.push(close);
  }
}

// Wilder RSI over the recorded closes; null until enough bars exist.
function rsi(symbol: string): number | null {
  const p = closes.get(symbol);
  if (p === undefined || p.length < RSI_PERIOD + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = p.length - RSI_PERIOD; i < p.length; i++) {
    const d = p[i]! - p[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / RSI_PERIOD;
  const avgLoss = loss / RSI_PERIOD;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// --- strategy: one decision per symbol per bar ---
function decide(state: BarsState): OrderInput[] {
  const orders: OrderInput[] = [];
  if (state.warmingUp) return orders;
  let cashLeft = state.cash;
  for (const symbol of state.symbols.keys()) {
    const r = rsi(symbol);
    if (r === null) continue;
    const held = state.positions.get(symbol);
    if (held !== undefined && held.qty > 0n) {
      // Exit: bounce taken, panic deepened, or momentum normalised.
      const value = state.value(symbol, held.qty);
      const change = held.cost > 0n ? Number(value - held.cost) / Number(held.cost) : 0;
      if (change >= TAKE_PROFIT || change <= STOP_LOSS || r > RSI_EXIT) {
        orders.push({ side: "sell", symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      continue;
    }
    // Entry: deeply oversold only, sized inside the 25% weight cap.
    if (r < RSI_BUY) {
      const room = state.weightRoom(symbol);
      const cap = (state.equity * MAX_WEIGHT_BPS) / 10_000n;
      const spend = room < cap ? room : cap;
      const affordable = cashLeft / 2n;
      const amount = spend < affordable ? spend : affordable;
      if (amount >= MIN_BUY_USDC) {
        orders.push({ side: "buy", symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        cashLeft -= amount;
      }
    }
  }
  return orders;
}

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    recordCloses(state);
    return decide(state);
  },
});
