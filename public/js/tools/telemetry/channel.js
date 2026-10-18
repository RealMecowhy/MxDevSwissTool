/* global AbortSignal */
// One request at a time per polling channel.
//
// The dashboard polls several endpoints on timers (Prometheus, logs, PostgreSQL,
// OTLP traces, OTLP logs). A timer does not wait for the request it started: an
// endpoint slower than its interval used to collect a growing queue of identical
// requests, and answers arrived out of order. A tick that finds its channel busy
// is skipped.
//
// Generation: a response that belongs to a connection the user has since left
// (another profile, a disconnect) must not touch the current state. Starting a
// new generation clears the busy flags and makes every older request stale.

const busy = new Set();
let generation = 0;

export const TM_FETCH_TIMEOUT_MS = 15000;

export function tmNewGeneration() {
  generation++;
  busy.clear();
}

// A fetch that cannot hang forever: a half-open connection would otherwise keep
// its channel busy for good.
export function tmTimeoutSignal() {
  return AbortSignal.timeout(TM_FETCH_TIMEOUT_MS);
}

// run(isStale) must return a promise. Resolves to undefined when the tick was
// skipped because the channel was busy.
export function tmSingleFlight(channel, run) {
  if (busy.has(channel)) return Promise.resolve(undefined);
  const mine = generation;
  const isStale = () => mine !== generation;
  busy.add(channel);
  // run() starts synchronously, so the request is on its way before this returns.
  let started;
  try { started = Promise.resolve(run(isStale)); } catch (e) { started = Promise.reject(e); }
  return started.finally(() => { if (!isStale()) busy.delete(channel); });
}

// For a request that is not part of a timer (a button press): not queued behind
// the poll, but still dropped if the connection changed while it was in flight.
export function tmStaleCheck() {
  const mine = generation;
  return () => mine !== generation;
}
