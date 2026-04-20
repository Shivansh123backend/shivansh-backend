// Dispatch rate limiter — token-bucket gate for outbound dial rate.
// Wraps the call-enqueue path so bulk campaigns can't exceed Telnyx's
// per-account dial-rate cap and trigger 429 cascades.
//
// Configure with env DIAL_RATE_PER_SEC (default: 5).
// Set DIAL_RATE_PER_SEC=0 to disable.

const RATE = Math.max(0, Number(process.env.DIAL_RATE_PER_SEC ?? "5"));
const BURST = Math.max(1, Number(process.env.DIAL_RATE_BURST ?? "10"));

let tokens = BURST;
let lastRefill = Date.now();
const waiters: Array<() => void> = [];

function refill(): void {
  if (RATE <= 0) return;
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  if (elapsed <= 0) return;
  tokens = Math.min(BURST, tokens + elapsed * RATE);
  lastRefill = now;
}

function tryDrain(): void {
  while (waiters.length > 0 && tokens >= 1) {
    tokens -= 1;
    const w = waiters.shift();
    if (w) w();
  }
}

if (RATE > 0) {
  // Background refiller — wakes any waiters the moment a token becomes available
  setInterval(() => {
    refill();
    tryDrain();
  }, 100).unref();
}

/**
 * Block until a dispatch token is available. No-op if rate limiting is disabled.
 * Caller should `await acquireDispatchToken()` immediately before initiating
 * the outbound dial (Telnyx originate or worker enqueue).
 */
export function acquireDispatchToken(): Promise<void> {
  if (RATE <= 0) return Promise.resolve();
  refill();
  if (tokens >= 1) {
    tokens -= 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

export function dispatchLimiterStatus(): {
  enabled: boolean;
  rate_per_sec: number;
  burst: number;
  tokens_available: number;
  waiters_queued: number;
} {
  refill();
  return {
    enabled: RATE > 0,
    rate_per_sec: RATE,
    burst: BURST,
    tokens_available: Math.floor(tokens),
    waiters_queued: waiters.length,
  };
}
