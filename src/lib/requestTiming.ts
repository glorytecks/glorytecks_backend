import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/*
  Where an authenticated request's time went, as a Server-Timing header. The
  browser's DevTools show it on each request, and the admin's performance
  monitor reads it, so production can be measured from production instead of
  estimated. Durations and a call count only: no query, table or identifier
  leaves the server, and only a signed-in caller receives the header.
*/

interface Timing {
  startedAt: number;
  authMs: number;
  dbCalls: number;
  /** Time with at least one call open: parallel calls overlap, so a plain sum would overstate it. */
  dbMs: number;
  open: number;
  openedAt: number;
}

const store = new AsyncLocalStorage<Timing>();

const ms = (value: number) => value.toFixed(1);

export function requestTiming(req: Request, res: Response, next: NextFunction): void {
  const timing: Timing = { startedAt: performance.now(), authMs: 0, dbCalls: 0, dbMs: 0, open: 0, openedAt: 0 };
  const writeHead = res.writeHead;
  res.writeHead = function patched(this: Response, ...args: unknown[]) {
    if (req.user) {
      const total = performance.now() - timing.startedAt;
      res.setHeader(
        'Server-Timing',
        `total;dur=${ms(total)}, auth;dur=${ms(timing.authMs)}, db;dur=${ms(timing.dbMs)};desc="${timing.dbCalls} calls"`,
      );
      // The admin runs on its own origin; without this a browser hides the timing from page scripts.
      if (req.headers.origin) res.setHeader('Timing-Allow-Origin', req.headers.origin);
    }
    return (writeHead as (...a: unknown[]) => Response).apply(this, args);
  } as typeof res.writeHead;
  store.run(timing, next);
}

/** The Supabase clients' fetch. Reads the global at call time, so it stays replaceable. */
export const timedFetch: typeof fetch = async (input, init) => {
  const timing = store.getStore();
  if (!timing) return globalThis.fetch(input, init);
  timing.dbCalls += 1;
  if (timing.open === 0) timing.openedAt = performance.now();
  timing.open += 1;
  try {
    return await globalThis.fetch(input, init);
  } finally {
    timing.open -= 1;
    if (timing.open === 0) timing.dbMs += performance.now() - timing.openedAt;
  }
};

/** Run the identity check, recording how long it took. */
export async function timedAuth<T>(run: () => Promise<T>): Promise<T> {
  const timing = store.getStore();
  const started = performance.now();
  try {
    return await run();
  } finally {
    if (timing) timing.authMs += performance.now() - started;
  }
}
