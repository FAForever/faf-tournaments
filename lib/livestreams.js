// @ts-check
'use strict';
// ---------- "live now" on the Livestreams panel (decisions 56, 57) ----------
// Whether a tournament's livestreams are on air, and how many people watch. Twitch and YouTube both
// say so through their APIs, each with credentials of its own. A site admin sets them on the
// console (Livestreams tab, kept in db.liveCfg); the server's environment is the fallback:
//   Twitch client id + secret (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET): an app registered at
//     dev.twitch.tv. The server gets an app access token with the client-credentials grant (no user
//     login, nobody's consent) and asks Helix "Get Streams" (`/helix/streams?user_login=...`): a
//     channel that is live is in the answer, with `viewer_count`; one that is offline is simply not.
//   YouTube API key (YOUTUBE_API_KEY): a Google Cloud API key with the YouTube Data API v3 enabled.
//     A video link is one `videos.list` call (1 unit); a channel link (@handle, /channel/UC...)
//     looks at the channel's newest uploads (`playlistItems.list`, 1 unit) and asks `videos.list`
//     which of them is live, with `concurrentViewers` (absent when the owner hides it).
//     `search.list` is not used: it has a quota of its own of only 100 calls a day.
// Without credentials nothing is checked and the page shows no badge, exactly as before.
//
// A tournament is only checked on its own days, from 1 hour before a day's start to 12 hours
// after it (both settable; a day given without a time: that whole UTC day and the night after it),
// and not once it is finished, abandoned or imported. The same channel streams other events, so an
// old or a wrong tournament must never say "live". Only links to allowed sites (decision 51) are
// checked: the page shows the others as plain text. Checks happen while someone has the tournament
// open, at most once a minute per Twitch channel (all of a tournament's channels in one request)
// and every three minutes per YouTube link (its daily quota is the scarce one), and they never hold
// up the page: it gets the last answer, and the next poll the fresh one.

const https = require('https');
const SCHED = require('./schedule');

const HOUR = 3600000;
const DAY_MS = 86400000;
const STALE_MS = 10 * 60000;            // an answer older than this is not shown (the API is failing)

/** @typedef {{ twitchId: string, twitchSecret: string, ytKey: string, twitchEvery: number, ytEvery: number, before: number, after: number, off: boolean }} Cfg */
/** What the server's environment says (the fallback for every credential and interval). */
const ENV = {
  twitchId: process.env.TWITCH_CLIENT_ID || '',
  twitchSecret: process.env.TWITCH_CLIENT_SECRET || '',
  ytKey: process.env.YOUTUBE_API_KEY || '',
  twitchEvery: parseInt(process.env.LIVE_TWITCH_EVERY_S || '', 10) || 0,
  ytEvery: parseInt(process.env.LIVE_YOUTUBE_EVERY_S || '', 10) || 0
};
// Limits for what a site admin may set (seconds, hours).
const LIMITS = { twitchEvery: [30, 3600], ytEvery: [60, 86400], before: [0, 12], after: [1, 48] };
const DEFAULTS = { twitchEvery: 60, ytEvery: 180, before: 1, after: 12 };

/** @param {unknown} v @param {number[]} lim @param {number} d */
function clampNum(v, lim, d) {
  const n = typeof v === 'number' ? v : parseInt(String(v == null ? '' : v), 10);
  if (!isFinite(n)) return d;
  return Math.min(lim[1], Math.max(lim[0], Math.round(n)));
}

/**
 * The settings in force: what the console saved, else the environment, else the defaults.
 * @param {Record<string, any>} saved
 * @returns {Cfg}
 */
function effective(saved) {
  const s = saved || {};
  return {
    twitchId: String(s.twitchId || ENV.twitchId || ''),
    twitchSecret: String(s.twitchSecret || ENV.twitchSecret || ''),
    ytKey: String(s.ytKey || ENV.ytKey || ''),
    // the console's values are kept within LIMITS; the environment's are the operator's own call
    twitchEvery: s.twitchEvery ? clampNum(s.twitchEvery, LIMITS.twitchEvery, DEFAULTS.twitchEvery) : (ENV.twitchEvery > 0 ? ENV.twitchEvery : DEFAULTS.twitchEvery),
    ytEvery: s.ytEvery ? clampNum(s.ytEvery, LIMITS.ytEvery, DEFAULTS.ytEvery) : (ENV.ytEvery > 0 ? ENV.ytEvery : DEFAULTS.ytEvery),
    before: clampNum(s.before != null ? s.before : DEFAULTS.before, LIMITS.before, DEFAULTS.before),
    after: clampNum(s.after != null ? s.after : DEFAULTS.after, LIMITS.after, DEFAULTS.after),
    off: !!s.off
  };
}

/** @type {Record<string, any>} */
let SAVED = {};
/** @type {Cfg} */
let CFG = effective({});

/** @typedef {{ at: number, okAt: number, live: boolean, viewers: number | null, err: boolean }} Entry */
/** @type {Map<string, Entry>} */
const cache = new Map();
/** @type {Set<string>} */
const inflight = new Set();
/** @type {Map<string, { playlist: string | null, at: number }>} */
const ytUploads = new Map();
/** @type {{ token: string, exp: number } | null} */
let twToken = null;
/** @type {Record<string, { at: number, msg: string } | null>} */
const lastError = { twitch: null, youtube: null };
/** @type {Record<string, number>} */
const lastOk = { twitch: 0, youtube: 0 };
/** @type {Map<string, number>} */
const noted = new Map();

/**
 * Take new settings (the console's, from db.liveCfg). Changed credentials start from scratch: no
 * token, no remembered answers, no old error.
 * @param {Record<string, any>} saved
 */
function configure(saved) {
  const next = effective(saved || {});
  const twChanged = next.twitchId !== CFG.twitchId || next.twitchSecret !== CFG.twitchSecret;
  const ytChanged = next.ytKey !== CFG.ytKey;
  SAVED = Object.assign({}, saved || {});
  CFG = next;
  if (twChanged) {
    twToken = null;
    for (const k of Array.from(cache.keys())) if (k.indexOf('tw:') === 0) cache.delete(k);
    lastError.twitch = null; lastOk.twitch = 0; noted.delete('twitch');
  }
  if (ytChanged) {
    for (const k of Array.from(cache.keys())) if (k.indexOf('yt') === 0) cache.delete(k);
    ytUploads.clear();
    lastError.youtube = null; lastOk.youtube = 0; noted.delete('youtube');
  }
}

/** @param {string} s */
function tail(s) { return s ? s.slice(-4) : ''; }
/**
 * What the console shows. Secrets never leave the server: only whether one is set, where from,
 * and its last 4 characters so a site admin can tell which key it is.
 */
function settings() {
  /** @param {'twitchId' | 'twitchSecret' | 'ytKey'} k */
  const from = k => (SAVED[k] ? 'here' : ENV[k] ? 'env' : '');
  return {
    off: CFG.off ? 1 : 0,
    twitchId: CFG.twitchId, twitchIdFrom: from('twitchId'),
    twitchSecret: { set: CFG.twitchSecret ? 1 : 0, tail: tail(CFG.twitchSecret), from: from('twitchSecret') },
    ytKey: { set: CFG.ytKey ? 1 : 0, tail: tail(CFG.ytKey), from: from('ytKey') },
    twitchEvery: CFG.twitchEvery, ytEvery: CFG.ytEvery, before: CFG.before, after: CFG.after,
    limits: LIMITS, defaults: DEFAULTS,
    active: { twitch: (!CFG.off && configured('twitch')) ? 1 : 0, youtube: (!CFG.off && configured('ytc')) ? 1 : 0 },
    lastError: { twitch: lastError.twitch, youtube: lastError.youtube },
    lastOk: { twitch: lastOk.twitch || 0, youtube: lastOk.youtube || 0 }
  };
}

/** @typedef {{ kind: 'twitch', key: string, login: string }
 *   | { kind: 'ytv', key: string, id: string }
 *   | { kind: 'ytc', key: string, channel: string, handle: string, user: string }} StreamRef */

// Twitch paths that are not channels.
const TWITCH_RESERVED = new Set(['videos', 'directory', 'p', 'search', 'settings', 'downloads', 'subscriptions',
  'inventory', 'wallet', 'drops', 'turbo', 'jobs', 'prime', 'store', 'friends', 'messages', 'payments',
  'moderator', 'popout', 'embed', 'login', 'signup', 'u']);
const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/;

/**
 * What a livestream link points at, if it is something we can ask about.
 * @param {string} url
 * @returns {StreamRef | null}
 */
function parseStream(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|go|player)\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  if (host === 'twitch.tv') {
    // player.twitch.tv/?channel=name is the embed form
    const login = String((seg[0] || u.searchParams.get('channel') || '')).toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(login) || TWITCH_RESERVED.has(login)) return null;
    if (seg[1] === 'video' || seg[1] === 'clip') return null;   // one past broadcast or clip, not the channel
    return { kind: 'twitch', key: 'tw:' + login, login };
  }
  if (host === 'youtu.be') {
    const id = seg[0] || '';
    return YT_VIDEO.test(id) ? { kind: 'ytv', key: 'ytv:' + id, id } : null;
  }
  if (host === 'youtube.com') {
    const first = seg[0] || '';
    if (first === 'watch') {
      const id = u.searchParams.get('v') || '';
      return YT_VIDEO.test(id) ? { kind: 'ytv', key: 'ytv:' + id, id } : null;
    }
    if (first === 'live' && YT_VIDEO.test(seg[1] || '')) return { kind: 'ytv', key: 'ytv:' + seg[1], id: seg[1] };
    if (/^@[A-Za-z0-9._-]{3,30}$/.test(first)) return { kind: 'ytc', key: 'ytc:h:' + first.toLowerCase(), channel: '', handle: first, user: '' };
    if (first === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(seg[1] || '')) return { kind: 'ytc', key: 'ytc:c:' + seg[1], channel: seg[1], handle: '', user: '' };
    if (first === 'user' && /^[A-Za-z0-9._-]{1,100}$/.test(seg[1] || '')) return { kind: 'ytc', key: 'ytc:u:' + seg[1].toLowerCase(), channel: '', handle: '', user: seg[1] };
    if (first === 'c' && /^[A-Za-z0-9._-]{3,30}$/.test(seg[1] || '')) return { kind: 'ytc', key: 'ytc:h:@' + seg[1].toLowerCase(), channel: '', handle: '@' + seg[1], user: '' };
  }
  return null;
}

/**
 * Is the tournament on its day right now? Each day of the event, from `before` hours before its
 * start to `after` hours after it (1 and 12 unless a site admin changed them); a day with no start
 * time, that whole day (UTC) and the night after it.
 * @param {any} t
 * @param {number} now
 * @returns {boolean}
 */
function liveWindowOpen(t, now) {
  if (!t || t.imported || t.abandoned || t.status === 'finished') return false;
  for (const d of SCHED.dayStarts(t)) {
    const start = Date.parse(d.day + 'T' + (d.time || '00:00') + ':00Z');
    if (isNaN(start)) continue;
    const from = d.time ? start - CFG.before * HOUR : start;
    const to = d.time ? start + CFG.after * HOUR : start + DAY_MS + 6 * HOUR;
    if (now >= from && now <= to) return true;
  }
  return false;
}

/** @param {'twitch' | 'ytv' | 'ytc'} kind */
function configured(kind) { return kind === 'twitch' ? !!(CFG.twitchId && CFG.twitchSecret) : !!CFG.ytKey; }

/** @param {string} what @param {unknown} e */
function note(what, e) {
  const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  lastError[what] = { at: Date.now(), msg };
  // one line per kind of failure every 10 minutes: a dead API must not flood the log
  const last = noted.get(what) || 0;
  if (Date.now() - last < 600000) return;
  noted.set(what, Date.now());
  console.warn('[livestreams] ' + what + ': ' + msg);
}

/**
 * The reason an API gives in its error answer, if any (never a secret: Twitch says e.g. "invalid
 * client secret", Google "API key not valid. Please pass a valid API key.").
 * @param {string} text
 */
function apiReason(text) {
  try {
    const j = JSON.parse(text);
    const m = (j && j.error && typeof j.error === 'object' && j.error.message) || (j && j.message) || '';
    return m ? ': ' + String(m).slice(0, 200) : '';
  } catch (e) { return ''; }
}

/**
 * @param {{ host: string, path: string, method?: string, headers?: Record<string, string | number> }} opts
 * @param {string} [body]
 * @returns {Promise<{ status: number, text: string }>}
 */
function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: opts.host, path: opts.path, method: opts.method || 'GET', headers: opts.headers || {} }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        data += c;
        if (data.length > 4000000) { req.destroy(); reject(new Error(opts.host + ': answer too large')); }
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, text: data }));
    });
    req.on('error', e => reject(new Error(opts.host + ': ' + e.message)));
    req.setTimeout(8000, () => { req.destroy(); reject(new Error(opts.host + ' timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

// ---- Twitch ----
/** An app access token for these credentials (the caller decides whether to keep it).
 * @param {string} id @param {string} secret @returns {Promise<{ token: string, exp: number }>} */
async function newTwitchToken(id, secret) {
  const body = 'client_id=' + encodeURIComponent(id) + '&client_secret=' + encodeURIComponent(secret) + '&grant_type=client_credentials';
  const r = await request({ host: 'id.twitch.tv', path: '/oauth2/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
  if (r.status !== 200) throw new Error('token ' + r.status + apiReason(r.text));
  const j = JSON.parse(r.text);
  if (!j || !j.access_token) throw new Error('token: no access_token');
  // renewed 5 minutes before it runs out (they last about two months)
  return { token: String(j.access_token), exp: Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000 };
}
/** @param {boolean} force @returns {Promise<string>} */
async function twitchToken(force) {
  if (!force && twToken && Date.now() < twToken.exp) return twToken.token;
  twToken = await newTwitchToken(CFG.twitchId, CFG.twitchSecret);
  return twToken.token;
}
/** @param {string[]} logins @param {string} id @param {string} token */
function helixStreams(logins, id, token) {
  const q = logins.map(l => 'user_login=' + encodeURIComponent(l)).join('&');
  return request({ host: 'api.twitch.tv', path: '/helix/streams?' + q + '&first=100',
    headers: { 'Client-Id': id, Authorization: 'Bearer ' + token } });
}
/**
 * The live ones among up to 100 channels: login -> viewers.
 * @param {string[]} logins @param {boolean} [retried]
 * @returns {Promise<Record<string, number | null>>}
 */
async function twitchLive(logins, retried) {
  const token = await twitchToken(!!retried);
  const r = await helixStreams(logins, CFG.twitchId, token);
  if (r.status === 401 && !retried) return twitchLive(logins, true);   // the token was revoked or ran out
  if (r.status !== 200) throw new Error('streams ' + r.status + apiReason(r.text));
  const j = JSON.parse(r.text);
  /** @type {Record<string, number | null>} */
  const out = {};
  for (const s of (j && Array.isArray(j.data) ? j.data : [])) {
    if (s && s.type === 'live' && s.user_login) out[String(s.user_login).toLowerCase()] = typeof s.viewer_count === 'number' ? s.viewer_count : null;
  }
  return out;
}

// ---- YouTube ----
/** @param {string} pathAndQuery @param {string} [key] @returns {Promise<any>} */
async function ytGet(pathAndQuery, key) {
  const r = await request({ host: 'www.googleapis.com', path: '/youtube/v3/' + pathAndQuery + '&key=' + encodeURIComponent(key || CFG.ytKey) });
  if (r.status !== 200) throw new Error(pathAndQuery.split('?')[0] + ' ' + r.status + apiReason(r.text));
  return JSON.parse(r.text);
}
/** Which of these videos is live, and its viewers (null when the owner hides them).
 * @param {string[]} ids @returns {Promise<{ viewers: number | null } | null>} */
async function ytLiveAmong(ids) {
  if (!ids.length) return null;
  const j = await ytGet('videos?part=snippet,liveStreamingDetails&id=' + ids.map(encodeURIComponent).join(','));
  for (const v of (j && Array.isArray(j.items) ? j.items : [])) {
    if (v && v.snippet && v.snippet.liveBroadcastContent === 'live') {
      const n = v.liveStreamingDetails ? v.liveStreamingDetails.concurrentViewers : null;
      return { viewers: (n != null && n !== '' && isFinite(Number(n))) ? Number(n) : null };
    }
  }
  return null;
}
/** A channel's uploads playlist, looked up once a day.
 * @param {{ key: string, channel: string, handle: string, user: string }} p @returns {Promise<string | null>} */
async function ytUploadsOf(p) {
  const c = ytUploads.get(p.key);
  if (c && Date.now() - c.at < DAY_MS) return c.playlist;
  const q = p.channel ? 'id=' + encodeURIComponent(p.channel)
    : p.handle ? 'forHandle=' + encodeURIComponent(p.handle) : 'forUsername=' + encodeURIComponent(p.user);
  const j = await ytGet('channels?part=contentDetails&' + q);
  const it = j && Array.isArray(j.items) ? j.items[0] : null;
  const pl = (it && it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.uploads) || null;
  ytUploads.set(p.key, { playlist: pl, at: Date.now() });
  return pl;
}
/** @param {StreamRef} p @returns {Promise<{ viewers: number | null } | null>} */
async function youtubeLive(p) {
  if (p.kind === 'ytv') return ytLiveAmong([p.id]);
  if (p.kind !== 'ytc') return null;
  const pl = await ytUploadsOf(p);
  if (!pl) return null;
  // the newest 25: a stream scheduled days ago sits below whatever was uploaded since (Shorts too)
  const j = await ytGet('playlistItems?part=contentDetails&maxResults=25&playlistId=' + encodeURIComponent(pl));
  const ids = (j && Array.isArray(j.items) ? j.items : []).map((/** @type {any} */ i) => i && i.contentDetails && i.contentDetails.videoId).filter(Boolean);
  return ytLiveAmong(ids);
}

// ---- the cache ----
/** @param {string} key @param {{ viewers: number | null } | null} found */
function store(key, found) {
  const at = Date.now();
  cache.set(key, { at, okAt: at, live: !!found, viewers: found ? found.viewers : null, err: false });
}
/** @param {string} key */
function failed(key) {
  const c = cache.get(key);
  // keep the last answer for a while, and do not ask again before the usual interval
  cache.set(key, { at: Date.now(), okAt: c ? c.okAt : 0, live: c ? c.live : false, viewers: c ? c.viewers : null, err: true });
}

/** @param {string[]} logins */
function refreshTwitch(logins) {
  for (const l of logins) inflight.add('tw:' + l);
  return twitchLive(logins)
    .then(found => { for (const l of logins) store('tw:' + l, l in found ? { viewers: found[l] } : null); lastOk.twitch = Date.now(); })
    .catch(e => { for (const l of logins) failed('tw:' + l); note('twitch', e); })
    .then(() => { for (const l of logins) inflight.delete('tw:' + l); });
}
/** @param {StreamRef} p */
function refreshYoutube(p) {
  inflight.add(p.key);
  return youtubeLive(p)
    .then(found => { store(p.key, found); lastOk.youtube = Date.now(); })
    .catch(e => { failed(p.key); note('youtube', e); })
    .then(() => { inflight.delete(p.key); });
}

/**
 * The live state of each of a tournament's livestreams, in their order: { live: 1, viewers } or
 * { live: 0 } when known, null when not asked or not known (no badge). Null altogether outside
 * the tournament's days, without credentials, or switched off. Starts the checks that are due
 * without waiting for them: the page gets the answer on its next poll.
 * @param {any} t
 * @param {number} now
 * @param {(url: string) => boolean} [allowed]  is this link on the allowed sites? (others: null)
 * @returns {Array<{ live: 1, viewers: number | null } | { live: 0 } | null> | null}
 */
function statusFor(t, now, allowed) {
  if (CFG.off) return null;
  const streams = (t && Array.isArray(t.streams)) ? t.streams : [];
  if (!streams.length || !liveWindowOpen(t, now)) return null;
  /** @type {Array<StreamRef | null>} */
  const refs = streams.map((/** @type {any} */ s) => {
    const url = String((s && s.url) || '');
    return (allowed && !allowed(url)) ? null : parseStream(url);
  });
  if (!refs.some(p => p && configured(p.kind))) return null;
  /** @type {string[]} */
  const dueTw = [];
  for (const p of refs) {
    if (!p || !configured(p.kind) || inflight.has(p.key)) continue;
    const c = cache.get(p.key);
    const every = (p.kind === 'twitch' ? CFG.twitchEvery : CFG.ytEvery) * 1000;
    if (c && now - c.at < every) continue;
    if (p.kind === 'twitch') { if (dueTw.indexOf(p.login) < 0) dueTw.push(p.login); }
    else refreshYoutube(p);
  }
  if (dueTw.length) refreshTwitch(dueTw.slice(0, 100));   // every Twitch channel of the tournament in one request
  return refs.map(p => {
    if (!p || !configured(p.kind)) return null;
    const c = cache.get(p.key);
    if (!c || !c.okAt || now - c.okAt > STALE_MS) return null;
    return c.live ? { live: /** @type {1} */ (1), viewers: c.viewers } : { live: /** @type {0} */ (0) };
  });
}

/**
 * The console's Test buttons: do these credentials work? Uses what the form holds (falling back to
 * what is saved), remembers nothing, and costs one token and one Helix request, or 1 YouTube unit.
 * @param {'twitch' | 'youtube'} which
 * @param {{ twitchId?: string, twitchSecret?: string, ytKey?: string }} [creds]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function test(which, creds) {
  const c = creds || {};
  try {
    if (which === 'twitch') {
      const id = String(c.twitchId || CFG.twitchId || ''), secret = String(c.twitchSecret || CFG.twitchSecret || '');
      if (!id || !secret) return { ok: false, message: 'Enter the client id and the client secret first.' };
      const tok = await newTwitchToken(id, secret);
      const r = await helixStreams(['twitch'], id, tok.token);
      if (r.status !== 200) return { ok: false, message: 'Twitch gave a token but refused the streams request (' + r.status + apiReason(r.text) + ').' };
      return { ok: true, message: 'Twitch accepted the credentials.' };
    }
    const key = String(c.ytKey || CFG.ytKey || '');
    if (!key) return { ok: false, message: 'Enter the API key first.' };
    // "Me at the zoo", the first video on YouTube: 1 unit
    await ytGet('videos?part=id&id=jNQXAC9IVRw', key);
    return { ok: true, message: 'YouTube accepted the key.' };
  } catch (e) {
    return { ok: false, message: (which === 'twitch' ? 'Twitch' : 'YouTube') + ' said no: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

module.exports = { parseStream, liveWindowOpen, statusFor, configured, configure, settings, test, LIMITS, DEFAULTS };
