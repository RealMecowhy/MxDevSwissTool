'use strict';

// The initial buffer read grabs "roughly the last 15 KB"; the incremental read
// should not be allowed to dwarf that. After a rotation the caller resets its
// cursor to 0, so without a cap the next growth event reads the whole new file
// synchronously — this bounds that to the tail that actually matters for a live
// view.
const MAX_TAIL_BYTES = 2 * 1024 * 1024; // 2 MB

// Given the last known size and the current size, return the byte range to read
// for the tail, or null when there is nothing new.
//   { start, length, skippedBytes }
// skippedBytes > 0 means the file grew by more than MAX_TAIL_BYTES since the
// last read and the middle was dropped — the caller logs that so a gap in the
// live view is explained rather than silent.
function computeTailRead(lastSize, newSize, maxBytes) {
  const cap = maxBytes || MAX_TAIL_BYTES;
  const last = Math.max(0, Number(lastSize) || 0);
  const now = Math.max(0, Number(newSize) || 0);
  if (now <= last) return null;
  const growth = now - last;
  if (growth <= cap) return { start: last, length: growth, skippedBytes: 0 };
  return { start: now - cap, length: cap, skippedBytes: growth - cap };
}

module.exports = { MAX_TAIL_BYTES, computeTailRead };
