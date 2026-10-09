// @ts-check
'use strict';
// Which websites user-written text may link to (decision 51). Every link anyone types - in a
// tournament's description, rewards, sponsors, lobby options or mods, a livestream row, a news
// post, a series description or a FAQ article - must point at an allowed site, and so must an
// image loaded from the web (pictures uploaded to this site are always fine). The list is edited
// by tournament directors and site admins on the console; until someone does, it is FAF and
// Discord. public/app.js mirrors siteAllowed()/hostOf() for showing text that was saved before.

/** @type {string[]} */
const DEFAULT_SITES = ['faforever.com', 'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net'];

/**
 * The host of an http(s) URL, lower case, without a leading "www.". Null for anything else
 * (relative links, javascript:, mailto:, junk).
 * @param {string} url
 * @returns {string|null}
 */
function hostOf(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  return h.replace(/^www\./, '');
}

/**
 * Turn what a director typed ("https://www.twitch.tv/foo", "Twitch.tv", "*.example.org") into
 * the bare site, or null if it is not one. A site covers its subdomains, so "faforever.com"
 * also allows forum.faforever.com.
 * @param {unknown} input
 * @returns {string|null}
 */
function cleanSite(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\*\./, '');
  if (!/^[a-z]+:\/\//.test(s)) s = 'https://' + s;
  const h = hostOf(s);
  if (!h || h.indexOf('.') < 0 || h.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(h) || /^[.-]|[.-]$|\.\./.test(h)) return null;
  return h;
}

/**
 * Is this host one of the sites, or a subdomain of one? Exact labels only: "faforever.com"
 * allows "forum.faforever.com" but not "notfaforever.com" or "faforever.com.example.org".
 * @param {string|null} host
 * @param {string[]} sites
 */
function siteAllowed(host, sites) {
  if (!host) return false;
  return (sites || []).some(s => host === s || host.endsWith('.' + s));
}

/**
 * Every URL text would turn into a link or an image: the target of [text](url) and ![alt](url),
 * the same pattern the page renders (public/app.js renderArticleBody).
 * @param {unknown} text
 * @returns {string[]}
 */
function linksIn(text) {
  const out = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  const s = String(text == null ? '' : text);
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

/**
 * The hosts in these texts that are not allowed, each once, in the order they appear. Only
 * http(s) targets count: anything else is never made clickable by the page in the first place.
 * @param {unknown[]} texts
 * @param {string[]} sites
 * @returns {string[]}
 */
function blockedHosts(texts, sites) {
  const bad = [];
  for (const t of texts) {
    for (const url of linksIn(t)) {
      const h = hostOf(url);
      if (h && !siteAllowed(h, sites) && bad.indexOf(h) < 0) bad.push(h);
    }
  }
  return bad;
}

/**
 * The message a refused save gets.
 * @param {string[]} hosts
 * @param {string[]} sites
 */
function refusal(hosts, sites) {
  return 'Links to ' + hosts.join(', ') + ' are not allowed. Allowed sites: ' + sites.join(', ') +
    '. A tournament director can add a site on the console (Allowed links).';
}

module.exports = { DEFAULT_SITES, hostOf, cleanSite, siteAllowed, linksIn, blockedHosts, refusal };
