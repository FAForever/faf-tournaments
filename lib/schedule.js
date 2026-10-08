// @ts-check
'use strict';
// ---------- event schedule: per-day start times, and moving an event ----------
// A multi-day event (`eventDays`, two or more 'YYYY-MM-DD') used to have one start time, the one
// in `eventDate`. Organizers can now say whether every day starts at that time
// (`dayTimesMode: 'same'`) or give each later day its own (`'perday'`, with `dayTimes` mapping
// 'YYYY-MM-DD' -> 'HH:MM', UTC like every other time on the site). Day 1's start is always
// `eventDate` itself, so there is exactly one place it lives. Until the question is answered
// (`dayTimesMode` null) a multi-day event cannot be published.
//
// Moving an event (the calendar's drag and drop) shifts the whole timeline by whole days: the
// event date, its days, the per-day times that hang off them, when signups open and close and the
// check-in deadline. A scheduled publish is left alone: moving an event earlier must never make
// a draft publish itself on the spot.

const DAY_MS = 86400000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 'YYYY-MM-DD' plus n days, in UTC.
 * @param {string} ymd
 * @param {number} n
 * @returns {string}
 */
function addDaysYmd(ymd, n) {
  const p = String(ymd).split('-');
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Whole days from a to b ('YYYY-MM-DD' both), negative when b is earlier.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/**
 * Shift a stored date by n days. A bare date stays a bare date; a datetime keeps its UTC time.
 * @param {string|null|undefined} v
 * @param {number} n
 * @returns {string|null}
 */
function shiftIso(v, n) {
  if (!v) return v == null ? null : v;
  const s = String(v);
  if (YMD.test(s)) return addDaysYmd(s, n);
  const ms = Date.parse(s);
  if (isNaN(ms)) return s;
  return new Date(ms + n * DAY_MS).toISOString();
}

/**
 * @param {unknown} v
 * @returns {'same'|'perday'|null}
 */
function cleanDayTimesMode(v) {
  return v === 'same' || v === 'perday' ? v : null;
}

/**
 * Keep only valid 'HH:MM' times for the given days, never day 1 (that one is eventDate's time).
 * Returns null when nothing is left.
 * @param {unknown} v
 * @param {string[]|null|undefined} days
 * @returns {Record<string,string>|null}
 */
function cleanDayTimes(v, days) {
  if (!v || typeof v !== 'object') return null;
  const list = Array.isArray(days) ? days.slice().sort() : [];
  /** @type {Record<string,string>} */
  const out = {};
  const src = /** @type {Record<string,unknown>} */ (v);
  for (const d of list.slice(1)) {
    const tm = src[d];
    if (typeof tm === 'string' && HHMM.test(tm)) out[d] = tm;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The days an event runs on, sorted; [] for a single-day (or undated) event.
 * @param {{eventDays?: string[]|null}} t
 * @returns {string[]}
 */
function multiDays(t) {
  const d = (t && Array.isArray(t.eventDays)) ? t.eventDays.slice().sort() : [];
  return d.length > 1 ? d : [];
}

/**
 * 'HH:MM' of the event date in UTC, or null when it carries no time.
 * @param {string|null|undefined} eventDate
 * @returns {string|null}
 */
function firstDayTime(eventDate) {
  if (!eventDate) return null;
  const s = String(eventDate);
  if (YMD.test(s)) return null;
  const ms = Date.parse(s);
  if (isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * Why this tournament may not be published yet as far as its schedule goes, or null.
 * @param {{eventDays?: string[]|null, eventDate?: string|null, dayTimesMode?: string|null, dayTimes?: Record<string,string>|null}} t
 * @returns {string|null}
 */
function scheduleProblem(t) {
  const days = multiDays(t);
  if (!days.length) return null;
  if (!t.dayTimesMode) {
    return 'This event runs on ' + days.length + ' days. Before publishing, say on the Admin tab whether every day starts at the same time (Different start times per day: yes or no).';
  }
  if (t.dayTimesMode === 'perday') {
    if (!firstDayTime(t.eventDate)) return 'Set a start time for the first day (the event time) before publishing.';
    const times = t.dayTimes || {};
    const missing = days.slice(1).filter(d => !times[d]);
    if (missing.length) return 'Set a start time for every day before publishing - missing: ' + missing.join(', ') + '.';
  }
  return null;
}

/**
 * Every day's start, in order: { day, time } with time 'HH:MM' UTC or null (no time set).
 * A single-day event gives one entry, an undated one none.
 * @param {{eventDays?: string[]|null, eventDate?: string|null, dayTimesMode?: string|null, dayTimes?: Record<string,string>|null}} t
 * @returns {{day: string, time: string|null}[]}
 */
function dayStarts(t) {
  const days = multiDays(t);
  const t1 = firstDayTime(t.eventDate);
  if (!days.length) {
    if (!t.eventDate) return [];
    return [{ day: String(t.eventDate).slice(0, 10), time: t1 }];
  }
  const per = t.dayTimesMode === 'perday' ? (t.dayTimes || {}) : {};
  return days.map((d, i) => ({ day: d, time: i === 0 ? t1 : (per[d] || t1) }));
}

/**
 * Shift the whole timeline by n days (see the header). Returns what moved, for the log.
 * @param {any} t
 * @param {number} n
 * @returns {{from: string|null, to: string|null}}
 */
function shiftSchedule(t, n) {
  const from = t.eventDate ? String(t.eventDate).slice(0, 10) : null;
  if (!n) return { from, to: from };
  t.eventDate = shiftIso(t.eventDate, n);
  if (Array.isArray(t.eventDays) && t.eventDays.length) t.eventDays = t.eventDays.map((/** @type {string} */ d) => addDaysYmd(d, n)).sort();
  if (t.dayTimes && typeof t.dayTimes === 'object') {
    /** @type {Record<string,string>} */
    const moved = {};
    for (const k of Object.keys(t.dayTimes)) moved[addDaysYmd(k, n)] = t.dayTimes[k];
    t.dayTimes = moved;
  }
  t.signupOpensAt = shiftIso(t.signupOpensAt, n);
  t.signupClosesAt = shiftIso(t.signupClosesAt, n);
  if (typeof t.checkInDeadline === 'number' && isFinite(t.checkInDeadline)) t.checkInDeadline += n * DAY_MS;
  return { from, to: t.eventDate ? String(t.eventDate).slice(0, 10) : null };
}

module.exports = {
  DAY_MS, addDaysYmd, daysBetween, shiftIso, cleanDayTimesMode, cleanDayTimes, multiDays,
  firstDayTime, scheduleProblem, dayStarts, shiftSchedule
};
