import type { StreamPart } from "@gx/contracts";

/**
 * Batch token deltas so the realtime stream gets a few writes per second instead of one per token.
 * Writes stay in order; a failed write is reported but never fails the turn.
 */
export function createCoalescer(
  write: (p: StreamPart) => Promise<void>,
  onError: (e: unknown) => void,
  { maxChars = 64, maxMs = 50 } = {},
) {
  let buf: StreamPart | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();

  const flushNow = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!buf) return;
    const part = buf;
    buf = null;
    chain = chain.then(() => write(part)).catch(onError);
  };

  return {
    push(p: StreamPart) {
      if (buf && (buf.t !== p.t || buf.step !== p.step)) flushNow();
      buf = buf ? { ...buf, d: buf.d + p.d } : { ...p };
      if (buf.d.length >= maxChars) flushNow();
      else timer ??= setTimeout(flushNow, maxMs);
    },
    async flush() {
      flushNow();
      await chain;
    },
  };
}
