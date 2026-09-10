/* ──────────────────────────────────────────────────────────────
   BOOKING AVAILABILITY — the one file you edit to change when
   readings can be booked.

   Both readers work day jobs, so readings only open on the days
   and times listed in WEEKLY_HOURS below. Everything else in the
   booking flow (the time picker on the site, the server-side
   check at checkout) is generated from this file, so there is
   never a second place to keep in sync.

   This file is prefixed with `_`, so Vercel does NOT serve it as
   an endpoint — it's a shared module for the api/ functions.
────────────────────────────────────────────────────────────── */

/* Your timezone. Every time in WEEKLY_HOURS is in THIS zone —
   customers see the same slot converted to their own zone.
   Full list: en.wikipedia.org/wiki/List_of_tz_database_time_zones */
const TIMEZONE = 'America/New_York';

/* When you're both free. 0 = Sunday … 6 = Saturday.
   Each day holds any number of ['HH:MM','HH:MM'] windows in 24h
   time. An empty array means "no readings that day".
   A window is the span readings may START and FINISH inside — a
   60-minute reading will not be offered at 21:00 in a window that
   ends at 21:30. */
const WEEKLY_HOURS = {
  0: [['13:00', '17:00']],                  // Sunday — afternoon
  1: [],                                    // Monday — day jobs, closed
  2: [['19:00', '21:30']],                  // Tuesday — evening
  3: [],                                    // Wednesday — closed
  4: [['19:00', '21:30']],                  // Thursday — evening
  5: [],                                    // Friday — closed
  6: [['12:00', '17:00']],                  // Saturday — afternoon
};

/* One-off days you're unavailable (vacation, a wedding, a double
   shift). Dates are YYYY-MM-DD in YOUR timezone. */
const BLACKOUT_DATES = [
  // '2026-09-05',
];

/* How long each reading actually takes, in minutes. Used to keep
   sessions from overlapping and to stop a long reading being
   booked at the tail end of a short window. */
const READING_DURATIONS = {
  'Celtic Cross Reading': 60,
  'Past · Present · Path': 30,
  'Two Steps Between': 90,
};

const SLOT_INTERVAL_MINUTES = 30;   // start times offered: :00 and :30
const BUFFER_MINUTES = 15;          // breathing room between sessions
const MIN_LEAD_HOURS = 24;          // no bookings inside the next day
const BOOKING_WINDOW_DAYS = 30;     // how far ahead the calendar opens
const HOLD_MINUTES = 20;            // an in-progress checkout holds its slot this long

/* ── Timezone helpers ──────────────────────────────────────────
   Node on Vercel ships full ICU, so Intl does the DST math for
   us and we need no date library. */

const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The shop-local calendar fields for a given instant (ms since epoch).
function localParts(ms) {
  const out = {};
  for (const p of PARTS_FMT.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // Intl renders midnight as hour 24 in some ICU versions.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_INDEX[out.weekday],
  };
}

// TIMEZONE's UTC offset, in ms, at the given instant.
function offsetAt(ms) {
  const p = localParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

// A wall-clock time in TIMEZONE -> the instant it refers to.
// Two passes so DST transitions land on the right side of the jump.
function zonedToUtc(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetAt(wall);
  const second = wall - offsetAt(first);
  return second;
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseHM(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/* ── Slot generation ─────────────────────────────────────────── */

function readingDuration(reading) {
  return READING_DURATIONS[reading];
}

// Every slot the schedule allows for `reading`, ignoring bookings.
// Returns [{ startMs, endMs, dateKey }] in chronological order.
function scheduledSlots(reading, now = Date.now()) {
  const duration = readingDuration(reading);
  if (!duration) return [];

  const earliest = now + MIN_LEAD_HOURS * 3600 * 1000;
  const latest = now + BOOKING_WINDOW_DAYS * 86400 * 1000;
  const slots = [];

  // Walk day by day in shop-local time, from today through the
  // end of the booking window.
  const today = localParts(now);
  for (let dayOffset = 0; dayOffset <= BOOKING_WINDOW_DAYS + 1; dayOffset++) {
    // Noon avoids DST edges when stepping calendar days.
    const noon = Date.UTC(today.year, today.month - 1, today.day + dayOffset, 12);
    const d = new Date(noon);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const key = dateKey(year, month, day);
    if (BLACKOUT_DATES.includes(key)) continue;

    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    for (const [openHM, closeHM] of WEEKLY_HOURS[weekday] || []) {
      const open = parseHM(openHM);
      const close = parseHM(closeHM);
      for (let minutes = open; minutes + duration <= close; minutes += SLOT_INTERVAL_MINUTES) {
        const startMs = zonedToUtc(year, month, day, Math.floor(minutes / 60), minutes % 60);
        const endMs = startMs + duration * 60000;
        if (startMs < earliest || startMs > latest) continue;
        slots.push({ startMs, endMs, dateKey: key });
      }
    }
  }

  slots.sort((a, b) => a.startMs - b.startMs);
  return slots;
}

// Two sessions collide if they overlap once BUFFER_MINUTES is
// added around each of them.
function collides(slot, booking) {
  const buffer = BUFFER_MINUTES * 60000;
  return slot.startMs - buffer < booking.endMs && slot.endMs + buffer > booking.startMs;
}

/* ── What's already booked ───────────────────────────────────── */

// Statuses that mean the money is on its way or already here.
const HOLDING_STATUSES = ['succeeded', 'processing', 'requires_capture'];

/* Bookings live in Stripe PaymentIntent metadata — no separate
   database to keep in sync or pay for. A slot is taken if a
   payment for it succeeded/is settling, or if someone is on the
   card step for it right now (a hold that expires on its own).

   One caveat worth knowing: Stripe's search index is eventually
   consistent (a new PaymentIntent can take up to ~a minute to
   show up here). Two people starting checkout for the same slot
   inside that same minute could both be let through, so if you
   ever see two bookings land on one time, that's why — refund or
   reschedule one. If sales volume ever makes that a real
   problem, the fix is a proper bookings table (Supabase/KV) with
   a unique index on the slot; everything else here stays. */
async function bookedSessions(stripe, now = Date.now()) {
  // A booking for a future slot can only have been created inside
  // the booking window, so this bound keeps the query small no
  // matter how many readings you've sold.
  const createdAfter = Math.floor((now - (BOOKING_WINDOW_DAYS + 2) * 86400 * 1000) / 1000);
  const query = `metadata['kind']:'reading' AND created>${createdAfter}`;

  const sessions = [];
  let page;
  for (let i = 0; i < 5; i++) {
    const result = await stripe.paymentIntents.search({ query, limit: 100, page });
    for (const pi of result.data) {
      const startMs = Number(pi.metadata.slot_start_ms);
      const endMs = Number(pi.metadata.slot_end_ms);
      if (!startMs || !endMs || endMs < now) continue;

      const settled = HOLDING_STATUSES.includes(pi.status);
      const liveHold = pi.status !== 'canceled' && pi.created * 1000 > now - HOLD_MINUTES * 60000;
      if (settled || liveHold) sessions.push({ startMs, endMs, paymentIntentId: pi.id });
    }
    if (!result.has_more || !result.next_page) break;
    page = result.next_page;
  }
  return sessions;
}

// The slots a customer may actually pick right now.
async function openSlots(stripe, reading, now = Date.now()) {
  const scheduled = scheduledSlots(reading, now);
  if (!scheduled.length) return [];
  const booked = await bookedSessions(stripe, now);
  return scheduled.filter((slot) => !booked.some((b) => collides(slot, b)));
}

/* Checkout re-checks the chosen slot here rather than trusting
   the browser: the picker's list can be minutes stale, and the
   request itself can be replayed or hand-written. */
async function validateSlot(stripe, reading, startMs, now = Date.now()) {
  const duration = readingDuration(reading);
  if (!duration) return { ok: false, error: 'This reading isn’t available for booking yet.' };
  if (!Number.isFinite(startMs)) return { ok: false, error: 'Choose a day and time for your reading.' };

  const scheduled = scheduledSlots(reading, now);
  const slot = scheduled.find((s) => s.startMs === startMs);
  if (!slot) {
    return { ok: false, error: 'That time isn’t one we hold readings in — pick another from the list.' };
  }

  const booked = await bookedSessions(stripe, now);
  if (booked.some((b) => collides(slot, b))) {
    return { ok: false, error: 'That time was just taken — pick another and we’ll hold it for you.' };
  }
  return { ok: true, slot };
}

/* ── Formatting ──────────────────────────────────────────────── */

const LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  weekday: 'long', month: 'long', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

// e.g. "Thursday, September 4 at 7:00 PM EDT" — what you and the
// customer both read on the confirmation.
function shopTimeLabel(startMs) {
  return LABEL_FMT.format(new Date(startMs)).replace(/,\s(\d)/, ' at $1');
}

module.exports = {
  TIMEZONE,
  WEEKLY_HOURS,
  BLACKOUT_DATES,
  READING_DURATIONS,
  SLOT_INTERVAL_MINUTES,
  BUFFER_MINUTES,
  MIN_LEAD_HOURS,
  BOOKING_WINDOW_DAYS,
  HOLD_MINUTES,
  readingDuration,
  scheduledSlots,
  bookedSessions,
  openSlots,
  validateSlot,
  shopTimeLabel,
};
