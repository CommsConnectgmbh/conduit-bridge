// When may the bridge stop a running agent because nobody is watching it?
//
// Until 3.2.1 a turn was killed 30 minutes after the last app connection to
// *that chat* closed. Two things were wrong with that (bridge.log, 07./08.11.
// 2026, six kills, all of them healthy Codex runs):
//   - The app was often still connected, only showing another chat. The kill
//     message nevertheless said "without a connected app".
//   - A phone that goes to sleep is the normal case, not an orphan. The answer
//     streams into the DB either way and is replayed on the next attach, so
//     ending the run only threw away work the user had asked for.
//
// A run that really hangs is already caught by the stall watchdog (no output
// for CONDUIT_TURN_STALL_MS), and a run that loops while printing by the
// opt-in CONDUIT_MAX_TURN_MS. The orphan limit is therefore off by default
// and, when an operator turns it on, measures how long the *owner* has had no
// app connection at all, not how long one chat has been closed.

/** Smallest grace an operator can configure; shorter values are raised to it. */
export const ORPHAN_GRACE_MIN_MS = 60_000;
export const ORPHAN_GRACE_MAX_MS = 7 * 24 * 3600_000;

/**
 * Normalise the configured grace. 0 (the default) disables the limit; any
 * other value is clamped into [ORPHAN_GRACE_MIN_MS, ORPHAN_GRACE_MAX_MS].
 */
export function normaliseOrphanGrace(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(Math.max(ms, ORPHAN_GRACE_MIN_MS), ORPHAN_GRACE_MAX_MS);
}

/**
 * Decide what an expired orphan timer does.
 *
 * @param {object} o
 * @param {number} o.graceMs           normalised grace (0 = limit off)
 * @param {number} o.now               current time in ms
 * @param {boolean} o.turnAlive        the guarded process is still the running, unfinished turn
 * @param {boolean} o.ownerConnected   the owner has at least one open app connection to any chat
 * @param {number|null} o.ownerLastSeenAt  when the owner's last app connection closed
 * @returns {{action: "ignore"} | {action: "rearm", delayMs: number} | {action: "kill"}}
 */
export function orphanDecision({ graceMs, now, turnAlive, ownerConnected, ownerLastSeenAt }) {
  if (!graceMs || !turnAlive) return { action: "ignore" };
  if (ownerConnected) return { action: "rearm", delayMs: graceMs };
  // Unknown last-seen time: count from now rather than kill on a guess.
  const seen = Number.isFinite(ownerLastSeenAt) ? ownerLastSeenAt : now;
  const away = Math.max(0, now - seen);
  if (away < graceMs) return { action: "rearm", delayMs: graceMs - away };
  return { action: "kill" };
}
