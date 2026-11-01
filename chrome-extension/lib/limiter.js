// Per-model rate limiter: keeps requests under Gemini's tokens-per-minute and
// requests-per-minute quotas, and lets urgent requests (the page or selection the user
// is looking at) go before background document reading.
//
//   const ticket = await limiter.acquire(estimatedTokens, PRIORITY.USER);
//   ... call Gemini ...
//   ticket.settle(actualPromptTokens); // replace the estimate with the real count
//
// The counters (last minute's requests, 429 pause) can be saved and restored, so a restarted
// extension service worker keeps them: pass `saved` (from state()) and `onChange`.

export const PRIORITY = { USER: 0, BACKGROUND: 1 };

export class RateLimiter {
  constructor({ tpm, rpm, windowMs = 60_000, saved = null, onChange = () => {} }) {
    this.tpm = tpm;
    this.rpm = rpm;
    this.windowMs = windowMs;
    this.window = saved?.window ?? []; // admitted requests in the last windowMs: { at, tokens }
    this.queue = []; // waiting requests, most urgent first
    this.pausedUntil = saved?.pausedUntil ?? 0; // set after a 429: nobody goes until then
    this.timer = null;
    this.seq = 0;
    this.onChange = onChange;
  }

  // What to save: plain data only.
  state() {
    return { window: this.window.map(({ at, tokens }) => ({ at, tokens })), pausedUntil: this.pausedUntil };
  }

  // signal: an AbortSignal; aborting takes a waiting request out of the queue (rejects).
  acquire(tokens, priority = PRIORITY.BACKGROUND, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      // A single request bigger than the quota can only run alone; don't let it wait forever.
      const item = { tokens: Math.min(tokens, this.tpm), priority, seq: this.seq++, resolve };
      this.queue.push(item);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(item);
        if (i < 0) return; // already admitted
        this.queue.splice(i, 1);
        reject(signal.reason);
        this.pump();
      }, { once: true });
      this.pump();
    });
  }

  // After a 429: hold everyone back until Gemini's retry time.
  pauseFor(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.onChange();
    this.pump();
  }

  pump() {
    clearTimeout(this.timer);
    const now = Date.now();
    this.window = this.window.filter((e) => now - e.at < this.windowMs);
    while (this.queue.length) {
      const wait = this.waitMs(this.queue[0].tokens, now);
      if (wait > 0) {
        this.timer = setTimeout(() => this.pump(), wait);
        return;
      }
      const next = this.queue.shift();
      const entry = { at: now, tokens: next.tokens };
      this.window.push(entry);
      this.onChange();
      next.resolve({
        settle: (actual) => {
          if (actual > 0) entry.tokens = actual;
          this.onChange();
        },
      });
    }
  }

  // How long until `tokens` more fit into the window (0 = now). The most urgent request
  // waits at the head of the queue, so less urgent ones can't slip past it.
  waitMs(tokens, now) {
    if (this.pausedUntil > now) return this.pausedUntil - now;
    let used = this.window.reduce((sum, e) => sum + e.tokens, 0);
    let count = this.window.length;
    const fits = () => used + tokens <= this.tpm && count + 1 <= this.rpm;
    if (fits()) return 0;
    for (const e of this.window) {
      used -= e.tokens;
      count -= 1;
      if (fits()) return e.at + this.windowMs - now;
    }
    return this.windowMs;
  }
}
