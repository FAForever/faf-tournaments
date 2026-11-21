// NOTE: not yet `// @ts-check` (same reason as lib/match.js: untyped dynamic
// tournament objects). Behaviour verified by the runtime test suite.
// Swiss format: standings, round pairing, byes, completion, and the after-report
// progression hook. Imports the shared match primitives (newMatch, initMatchVetoes) from
// lib/match.js. lib/match.js calls swissAfterReport back via its injected hook, so
// there is no circular import (swiss -> match only).
//
// Two OPTIONAL layers sit on top of the classic round-count Swiss. Both are off unless
// explicitly configured, and when they are off every function here behaves exactly as it
// did before they existed:
//
//   1. RECORD CUTS (cfg.winCut / cfg.lossCut). A team leaves the stage the moment it
//      reaches either threshold instead of playing a fixed number of rounds - the format
//      used by CS/Valorant majors and by the FAF Invitational ("3 wins advance, 3 losses
//      eliminated"). cfg.rounds becomes a safety cap rather than the terminator.
//      cfg.decidingBo, if set, lengthens exactly those matches where a win qualifies
//      someone or a loss eliminates them.
//   2. STAGE 2 (t.stage2). Instead of crowning the top of the standings, the top N are
//      cut into a playoff bracket inside the SAME tournament. See stageTwoBuild below.
'use strict';

const { newMatch, initMatchVetoes, buildSingle, buildDouble, divisionChampion } = require('./match');

// Injected by the host, same idiom as lib/match.js. openStagePicks(t, field) may take over the
// stage-2 build to run an opponent pick phase first; it returns true when it did.
// removedMatches(t, ids): matches taken back (a decider or final that no longer fits), so the host
// can tidy what hung off them.
const hooks = { openStagePicks: null, removedMatches: null };
function setSwissHooks(h) { Object.assign(hooks, h); }

// ---------- divisions (King / Prince ...), decision 77 ----------
// A Swiss with divisions plays one Swiss per division: the same settings, but its own teams,
// rounds, standings and final. Everything below walks t.teams and t.matches, so a division is
// played by handing it a VIEW of the tournament that shows only that division's teams and
// matches. Everything else reads through to the tournament, every write lands on it, and a match
// made through the view goes into the tournament, in that division. The few entry points the
// host calls (pairing, after a report, the finish, the standings) run once per division.
function swissDivisionCount(t) {
  if (!t || t.swissDivision || t.bracketType !== 'swiss' || t.competition !== 'team') return 0;
  const n = parseInt(t.divisions, 10) || 0;
  return n > 1 ? n : 0;
}
function divisionView(t, d) {
  const teams = (t.teams || []).filter(x => (x.division || 0) === d);
  const own = list => {
    list.push = function () {
      for (let i = 0; i < arguments.length; i++) { arguments[i].division = d; t.matches.push(arguments[i]); }
      return Array.prototype.push.apply(this, arguments);
    };
    return list;
  };
  let matches = own((t.matches || []).filter(m => (m.division || 0) === d));
  return new Proxy(t, {
    get(target, key) {
      if (key === 'teams') return teams;
      if (key === 'matches') return matches;
      if (key === 'swissDivision') return d;
      if (key === 'swissTournament') return target;
      return target[key];
    },
    set(target, key, value) {
      if (key === 'matches') {
        // this division's matches rewritten: every other division keeps its own
        const keep = new Set(value);
        target.matches = target.matches.filter(m => (m.division || 0) !== d || keep.has(m));
        for (const m of value) if (target.matches.indexOf(m) < 0) { m.division = d; target.matches.push(m); }
        matches = own(value.slice());
        return true;
      }
      target[key] = value;
      return true;
    }
  });
}
// The tournament itself, from a division's view or from the tournament.
function wholeOf(t) { return (t && t.swissTournament) || t; }
// The champion of a division that plays no final (lib/match divisionChampion asks, through the
// host): the top of its table once its Swiss is decided. With a final, the final decides.
function swissDivisionChampion(t, d) {
  const all = wholeOf(t);
  if (!all || all.bracketType !== 'swiss' || !all.cfg || all.cfg.final || stageTwoCfg(all)) return null;
  if (!((parseInt(all.divisions, 10) || 0) >= d)) return null;
  const v = divisionView(all, d);
  if (!v.teams.length || !v.matches.some(m => m.bracket === 'sw')) return null;
  if (!swissStageDone(v)) return null;
  const top = swissStandings(v);
  return top.length ? top[0].teamId : null;
}

// ---------- optional record cuts ----------

// Normalised view of the cut config. `on` is false for every tournament that does not
// explicitly set a cut, which is the gate every new code path below tests.
function swissCuts(t) {
  const c = (t && t.cfg) || {};
  const w = parseInt(c.winCut, 10);
  const l = parseInt(c.lossCut, 10);
  const win = (w > 0) ? w : 0;
  const loss = (l > 0) ? l : 0;
  return { on: !!(win || loss), win, loss };
}

// The most rounds any single team can play under a set of cuts: it takes (win-1) wins and
// (loss-1) losses to still be alive, and the next game decides it. Used to derive a sane
// safety cap so "Round r / N" still reads correctly in the UI.
function swissCutRounds(win, loss) {
  const w = (win > 0) ? win : 0;
  const l = (loss > 0) ? loss : 0;
  if (!w && !l) return 0;
  if (!w) return l;
  if (!l) return w;
  return w + l - 1;
}

// ONE walk of the matches, shared by standings, progress and pairing, so those three can
// never disagree about a team's record. `state` is the only new concept:
//   'active'     - still playing
//   'advanced'   - hit the win cut (cuts only)
//   'eliminated' - hit the loss cut (cuts only)
//   'done'       - played its full round quota (no cuts)
function swissRecord(t) {
  const cuts = swissCuts(t);
  const rec = {};
  for (const team of t.teams) {
    rec[team.id] = { teamId: team.id, seed: team.seed, wins: 0, losses: 0, gd: 0, byes: 0, played: 0, pending: false, state: 'active' };
  }
  for (const m of t.matches) {
    if (m.bracket !== 'sw') continue;
    if (m.status === 'bye') {
      const id = m.team1 !== 'BYE' ? m.team1 : m.team2;
      if (rec[id]) { rec[id].wins++; rec[id].byes++; rec[id].gd += 1; rec[id].played++; }
    } else if (m.status === 'done') {
      const w = rec[m.winner], l = rec[m.loser];
      const ws = m.winner === m.team1 ? m.score1 : m.score2;
      const ls = m.winner === m.team1 ? m.score2 : m.score1;
      if (w) { w.wins++; w.gd += ws - ls; w.played++; }
      if (l) { l.losses++; l.gd -= ws - ls; l.played++; }
    } else {
      if (rec[m.team1]) rec[m.team1].pending = true;
      if (rec[m.team2]) rec[m.team2].pending = true;
    }
  }
  const quota = (t.cfg && t.cfg.rounds) || 0;
  for (const id of Object.keys(rec)) {
    const r = rec[id];
    if (cuts.on) {
      if (cuts.win && r.wins >= cuts.win) r.state = 'advanced';
      else if (cuts.loss && r.losses >= cuts.loss) r.state = 'eliminated';
      else if (quota && r.played >= quota) r.state = 'done';   // safety cap
    } else if (quota && r.played >= quota) {
      r.state = 'done';
    }
  }
  return rec;
}

// Teams still to be decided. Only meaningful with cuts on.
function swissActive(t, rec) {
  const r = rec || swissRecord(t);
  return t.teams.filter(x => r[x.id] && r[x.id].state === 'active').map(x => x.id);
}

// Everyone who cleared the win cut, best record first. This is the qualified field.
function swissAdvanced(t) {
  const rec = swissRecord(t);
  return swissSort(Object.values(rec).filter(r => r.state === 'advanced'), t, rec).map(r => r.teamId);
}

// ---------- the tiebreak between equal records ----------
// 'gd' (the default, and what every tournament has always used): game difference, then seed.
// 'beaten' (the Invitational's rule): the sum of the Swiss scores - wins - of the opponents a team
// BEAT, then a random order: "highest sum of total score (swiss score) of the opponents you beat -
// if its equal then just random order". The random order is seeded from the tournament's draw seed,
// so it is unpredictable beforehand and always the same afterwards, like the draw itself.
function swissTiebreakMode(t) { return (t && t.tiebreak === 'beaten') ? 'beaten' : 'gd'; }

// Sum of the current wins of every opponent each team has beaten in the Swiss. A bye beats nobody.
function beatenScores(t, rec) {
  const out = {};
  for (const id of Object.keys(rec)) out[id] = 0;
  for (const m of (t.matches || [])) {
    if (m.bracket !== 'sw' || m.status !== 'done') continue;
    if (!rec[m.winner] || !rec[m.loser]) continue;
    out[m.winner] += rec[m.loser].wins;
  }
  return out;
}
// A fixed pseudo-random number per team and tournament: the coin flip between equal records.
function tieRandom(t, teamId) {
  let x = 0x811c9dc5;
  const k = String((t && t.cfg && t.cfg.drawSeed) || (t && t.id) || 'seed') + '#tiebreak#' + teamId;
  for (let i = 0; i < k.length; i++) x = Math.imul(x ^ k.charCodeAt(i), 16777619) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
// The numbers the 'beaten' tiebreak ranks on, for showing on the standings table.
function swissTiebreakValues(t) {
  if (swissTiebreakMode(t) !== 'beaten') return null;
  return beatenScores(t, swissRecord(t));
}

// Wins first, then FEWER LOSSES, then game difference, then seed. The losses term only ever
// separates teams on the same wins, and there it is the one that matters: every qualifier has
// three wins, and a 3-0 is a better run than a 3-2 whatever the game difference says. Without it
// a 3-2 who won its three Bo3 deciders 2-0 (+4) out-ranked a 3-0 who won its one 2-1 (+3), and got the
// better playoff seed - and, with the opponent pick on, the pick that went with it.
// `t` selects the tiebreak; `recAll` is the full record (every team), which the 'beaten' tiebreak
// needs even when `rows` is only part of the table. Without `t` it is the default order.
function swissSort(rows, t, recAll) {
  if (swissTiebreakMode(t) !== 'beaten') {
    return rows.slice().sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.gd - a.gd || a.seed - b.seed);
  }
  const sb = beatenScores(t, recAll || swissRecord(t));
  const rnd = {};
  for (const r of rows) rnd[r.teamId] = tieRandom(t, r.teamId);
  return rows.slice().sort((a, b) => b.wins - a.wins || a.losses - b.losses
    || (sb[b.teamId] || 0) - (sb[a.teamId] || 0) || rnd[a.teamId] - rnd[b.teamId] || a.seed - b.seed);
}

function swissStandings(t) {
  const n = swissDivisionCount(t);
  const rec = swissRecord(t);
  if (n) {
    // one table per division, the top division first; a team in no division (only before the
    // start) after them
    let out = [];
    for (let d = 1; d <= n; d++) out = out.concat(swissStandings(divisionView(t, d)));
    const seen = new Set(out.map(r => r.teamId));
    return out.concat(swissSort(Object.values(rec).filter(r => !seen.has(r.teamId)), t, rec));
  }
  return swissSort(Object.values(rec), t, rec);
}

// A match is "deciding" when a win qualifies someone or a loss knocks them out. Those are the
// matches LotS plays longer. Returns the tournament Bo unless cuts AND a decidingBo are set.
function swissBoFor(t, rec, aId, bId) {
  const cfg = t.cfg || {};
  const cuts = swissCuts(t);
  const dec = parseInt(cfg.decidingBo, 10);
  if (!cuts.on || !(dec > 0)) return cfg.bo;
  const onTheLine = id => {
    const r = rec[id];
    if (!r) return false;
    if (cuts.win && r.wins === cuts.win - 1) return true;    // a win qualifies them
    if (cuts.loss && r.losses === cuts.loss - 1) return true; // a loss eliminates them
    return false;
  };
  return (onTheLine(aId) || onTheLine(bId)) ? dec : cfg.bo;
}

// Perfect matching inside one score group, avoiding pairs that have already met.
// Exhaustive with backtracking, because a greedy walk corners itself: in a 1-1 group every
// player has exactly one forbidden partner, and picking wrong early forces a rematch at the
// end. Score groups never exceed half the field (8 in a 16-player stage), so this is instant.
// Cost of a rematch, large enough that ONE rematch always outranks every possible same-stream
// pairing in a group. That makes the search lexicographic: never repeat a matchup if there is
// any way not to, and only then worry about crossing the streams.
const REMATCH_COST = 1000;

/**
 * Perfect matching inside one score group.
 *   forbidden[a|b]   - these two have already played. Avoided at almost any price.
 *   discouraged[a|b] - these two arrived in this group from the same place (see pairAcross).
 *                      Avoided, but never at the cost of a rematch.
 * Exhaustive with backtracking, because a greedy walk corners itself: in a 1-1 group every
 * player has exactly one forbidden partner, and picking wrong early forces a rematch at the end.
 * Score groups never exceed half the field (8 in a 16-player stage), so this is instant.
 */
function matchGroup(ids, forbidden, discouraged) {
  const n = ids.length;
  if (n % 2 === 1) return null;
  if (!n) return [];
  const dis = discouraged || {};
  const pairCost = (a, b) => (forbidden[a + '|' + b] ? REMATCH_COST : 0) + (dis[a + '|' + b] ? 1 : 0);
  // Iterative deepening on total cost: a perfect draw first, then the least-bad one. A small
  // field eventually runs out of fresh opponents (an 8-player 3/3 stage does), and drawing a
  // round with one repeat beats refusing to draw it at all.
  const ceiling = REMATCH_COST * n + n;
  for (let allow = 0; allow <= ceiling; allow = (allow < n ? allow + 1 : allow + REMATCH_COST)) {
    const used = new Array(n).fill(false);
    const out = [];
    const walk = (count, spent) => {
      if (count === n) return true;
      let i = 0;
      while (i < n && used[i]) i++;
      if (i >= n) return true;
      used[i] = true;
      for (let j = i + 1; j < n; j++) {
        if (used[j]) continue;
        const cost = pairCost(ids[i], ids[j]);
        if (spent + cost > allow) continue;
        used[j] = true;
        out.push([ids[i], ids[j]]);
        if (walk(count + 2, spent + cost)) return true;
        out.pop();
        used[j] = false;
      }
      used[i] = false;
      return false;
    };
    if (walk(0, 0)) return out;
  }
  return null;
}

// ---------- the draw ----------
// Pairing used to be fully deterministic: the same field produced the same draw every single
// time. The format asks for equal-score opponents drawn RANDOMLY, so the group is shuffled
// before matching. The shuffle is seeded from the tournament's own draw seed plus the round
// number, which means it is unpredictable in advance but reproducible afterwards - an organizer
// can always show that a round was drawn the way the record says it was.
function drawRng(t, round) {
  let x = 0;
  // each division draws from its own stream (decision 77); without divisions the key is unchanged
  const key = String((t.cfg && t.cfg.drawSeed) || t.id || 'seed') + (t.swissDivision ? '#d' + t.swissDivision : '') + '#' + round;
  for (let i = 0; i < key.length; i++) x = (x * 31 + key.charCodeAt(i)) >>> 0;
  if (!x) x = 0x9e3779b9;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// Each team's record as it stood going INTO `round` - which stream they arrived in this score
// group from. Two players on 2-2 are not in the same situation if one fell from 2-1 and the
// other climbed from 1-2, and the deciding round is meant to put those two against each other.
function recordsBefore(t, round) {
  const out = {};
  for (const team of t.teams) out[team.id] = { wins: 0, losses: 0 };
  for (const m of t.matches) {
    if (m.bracket !== 'sw' || m.round >= round) continue;
    if (m.status === 'bye') {
      const id = m.team1 !== 'BYE' ? m.team1 : m.team2;
      if (out[id]) out[id].wins++;
    } else if (m.status === 'done') {
      if (out[m.winner]) out[m.winner].wins++;
      if (out[m.loser]) out[m.loser].losses++;
    }
  }
  const key = {};
  for (const id of Object.keys(out)) key[id] = out[id].wins + '-' + out[id].losses;
  return key;
}

// Draw one round of a record-cut Swiss: split the active field into score groups, float the
// odd player down a group (standard Swiss practice), and find a rematch-free pairing inside
// each group.
function pairRoundByRecord(t, r, rec, standings, played) {
  const active = standings.filter(s => rec[s.teamId].state === 'active').map(s => s.teamId);
  if (!active.length) return;
  const rnd = drawRng(t, r);
  // The deciding round is the one where the last score group is the merge of two streams: the
  // players who FELL into it and the players who CLIMBED into it. That round pairs across the
  // two, which is the "2-2 from the upper side plays the 2-2 from the lower side" rule.
  // Earlier rounds are left as a plain random draw among equal scores, exactly as specified.
  const lastRound = (t.cfg && t.cfg.rounds) ? (r >= t.cfg.rounds && r > 1) : false;
  // NOT the record entering this round - by then everyone left is on the same one, so it tells
  // you nothing. It is the record entering the PREVIOUS round that says which side they came
  // from: at round 5 a 2-2 was either 2-1 and lost, or 1-2 and won.
  const origin = lastRound ? recordsBefore(t, r - 1) : null;
  const groups = [];
  for (const id of active) {
    const k = rec[id].wins + '-' + rec[id].losses;
    let g = groups[groups.length - 1];
    if (!g || g.k !== k) { g = { k, ids: [] }; groups.push(g); }
    g.ids.push(id);
  }
  // An odd group sends its lowest-ranked player down to the next one. That can make the next
  // group odd in turn, which is correct - the imbalance cascades to the bottom of the table.
  for (let i = 0; i < groups.length - 1; i++) {
    if (groups[i].ids.length % 2 === 1) groups[i + 1].ids.unshift(groups[i].ids.pop());
  }
  const last = groups[groups.length - 1];
  if (last.ids.length % 2 === 1) {
    // Bye: lowest-ranked player who has not had one yet. Under cuts a bye is a free win, so
    // it goes to whoever has had the least luck so far, and never twice to the same team.
    // Random among those who have not had one yet, rather than always the bottom of the table.
    const noBye = last.ids.filter(id => !rec[id].byes);
    const from = noBye.length ? noBye : last.ids;
    const chosen = shuffled(from, rnd)[0];
    let pick = last.ids.indexOf(chosen);
    if (pick < 0) pick = last.ids.length - 1;
    const byeTeam = last.ids.splice(pick, 1)[0];
    const bm = newMatch(t, 'sw', r, 99, t.cfg.bo);
    bm.team1 = byeTeam; bm.team2 = 'BYE'; bm.status = 'bye'; bm.winner = byeTeam; bm.loser = 'BYE';
    if (!last.ids.length) groups.pop();
  }
  let idx = 0;
  for (const g of groups) {
    // Random among equal scores: shuffle before matching, so the draw is not the standings order.
    // The shuffle runs on a CANONICAL order (seed), not on the standings order it arrived in.
    // Fisher-Yates on a different starting order gives a different permutation from the same
    // random stream, and the standings order is sorted by game difference - so without this the
    // draw, while still uniform, moved when a score changed even though nobody's win/loss did.
    // That is not bias, but it made "the draw depends on wins, losses and the seed, and nothing
    // else" untrue, and it was noticed: "worried that it may be also picking based on game diff".
    // Group MEMBERSHIP is still decided by record, and the float-down above still uses standings
    // order - game difference decides who changes group, never who plays whom inside one.
    const bySeed = g.ids.slice().sort((a, b) => (rec[a].seed || 0) - (rec[b].seed || 0));
    const pool = shuffled(bySeed, rnd);
    let discouraged = null;
    if (origin) {
      // same stream = same record going into this round. Discouraged, never forbidden: a
      // rematch is always the worse outcome, and matchGroup weighs them in that order.
      discouraged = {};
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          if (origin[pool[i]] === origin[pool[j]]) {
            discouraged[pool[i] + '|' + pool[j]] = 1;
            discouraged[pool[j] + '|' + pool[i]] = 1;
          }
        }
      }
    }
    const pairs = matchGroup(pool, played, discouraged) || [];
    for (const [a, b] of pairs) {
      const m = newMatch(t, 'sw', r, idx++, swissBoFor(t, rec, a, b));
      m.team1 = a; m.team2 = b; m.status = 'ready';
      initMatchVetoes(t, m);
    }
  }
}

function swissPairRound(t, r) {
  const nDiv = swissDivisionCount(t);
  if (nDiv) {
    // every division draws its own round from its own table
    for (let d = 1; d <= nDiv; d++) swissPairRound(divisionView(t, d), r);
    return;
  }
  // Opening matchups pinned before the stage started (see swissPlanRound1). Consumed here so
  // the cut path and the plain path both honour them, and cleared either way so a stale plan
  // can never be applied to a later round.
  if (r === 1 && t.plannedR1) {
    const plan = t.plannedR1;
    t.plannedR1 = null;
    if (applyPlannedRound1(t, plan)) return;
    // the field changed since it was pinned: fall through to the normal draw
  }
  const cuts = swissCuts(t);
  const rec = swissRecord(t);
  const standings = swissSort(Object.values(rec), t, rec);
  const played = {};
  for (const m of t.matches) {
    if (m.bracket === 'sw' && m.team1 && m.team2 && m.team1 !== 'BYE' && m.team2 !== 'BYE') {
      played[m.team1 + '|' + m.team2] = 1;
      played[m.team2 + '|' + m.team1] = 1;
    }
  }
  if (cuts.on) return pairRoundByRecord(t, r, rec, standings, played);
  const draw = classicDraw(standings.map(s => s.teamId), rec, played);
  if (draw.bye) {
    const bm = newMatch(t, 'sw', r, 99, t.cfg.bo);
    bm.team1 = draw.bye; bm.team2 = 'BYE'; bm.status = 'bye'; bm.winner = draw.bye; bm.loser = 'BYE';
  }
  let idx = 0;
  for (const [a, b] of draw.pairs) {
    const m = newMatch(t, 'sw', r, idx++, swissBoFor(t, rec, a, b));
    m.team1 = a; m.team2 = b; m.status = 'ready';
    initMatchVetoes(t, m);
  }
}

// ---------- the classic draw: down the table, never a rematch that can be avoided (decision 80) ----------
// Every team plays the next one down the table it has not met yet, and the bye goes to the lowest
// team that has not had one. That walk used to be greedy - take the first such opponent and move
// on - and greedy corners itself at the bottom of the table: Prince round 2 (Setons, 21 Nov) paired
// the top four 1v2, 3v4 and left the last two, who had met in round 1, to meet again, although a
// round without a rematch existed. "The pairing should always avoid rematches": the walk now looks
// ahead, taking the next team down only when the rest of the round can still be paired without a
// rematch, the bye included (the next lowest without a bye takes it when that is what it takes).
// Whenever the greedy walk found a round without a rematch, this finds the same round. Only when no
// such round exists at all does it allow rematches, as few as it can.
//
// The pairs of `ids` (best first), down the table, with at most `allow` rematches; null when there
// is no such round, or when the search ran out of steps (`budget`, which only a very large field
// could ever use up).
function pairDownTable(ids, played, allow, budget) {
  const n = ids.length;
  if (n % 2 === 1) return null;
  const used = new Array(n).fill(false);
  const fresh = ids.map((a, i) => ids.map((b, j) => j).filter(j => j !== i && !played[a + '|' + ids[j]]));
  const out = [];
  // with no rematch left to spend, every team still to pair needs someone left it has not met
  const deadEnd = () => {
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      budget.left -= fresh[i].length;
      if (!fresh[i].some(j => !used[j])) return true;
    }
    return false;
  };
  const walk = spent => {
    if (--budget.left < 0) return false;
    let i = 0;
    while (i < n && used[i]) i++;
    if (i >= n) return true;
    if (spent >= allow && deadEnd()) return false;
    used[i] = true;
    for (let j = i + 1; j < n; j++) {
      if (used[j]) continue;
      const cost = played[ids[i] + '|' + ids[j]] ? 1 : 0;
      if (spent + cost > allow) continue;
      used[j] = true;
      out.push([ids[i], ids[j]]);
      if (walk(spent + cost)) return true;
      out.pop();
      used[j] = false;
      if (budget.left < 0) break;
    }
    used[i] = false;
    return false;
  };
  return walk(0) ? out : null;
}
// The round for a table (`order`, best first): { bye, pairs }.
function classicDraw(order, rec, played) {
  // who may take the bye: the lowest in the table who has not had one, then the next one up; a
  // second bye only when everyone has had one
  let byes = [null];
  if (order.length % 2 === 1) {
    const none = order.filter(id => !(rec[id] && rec[id].byes)).reverse();
    byes = none.length ? none : order.slice().reverse();
  }
  const budget = { left: 300000 };
  for (let allow = 0; allow <= order.length / 2; allow++) {
    for (const bye of byes) {
      const pairs = pairDownTable(bye ? order.filter(id => id !== bye) : order, played, allow, budget);
      if (pairs) return { bye, pairs };
      if (budget.left < 0) break;
    }
    if (budget.left < 0) break;
  }
  // out of steps: the greedy walk, exactly as it always was
  const pool = order.slice();
  let bye = null;
  if (pool.length % 2 === 1) {
    let byeIdx = pool.length - 1;
    for (let i = pool.length - 1; i >= 0; i--) if (rec[pool[i]] && rec[pool[i]].byes === 0) { byeIdx = i; break; }
    bye = pool.splice(byeIdx, 1)[0];
  }
  const pairs = [];
  while (pool.length) {
    const a = pool.shift();
    let j = 0;
    while (j < pool.length - 1 && played[a + '|' + pool[j]]) j++;
    pairs.push([a, pool.splice(j, 1)[0]]);
  }
  return { bye, pairs };
}

// ---------- arranging round 1 by hand ----------
// Round 1 has no records to pair on, so it is drawn by seed and comes out the same every time.
// Some formats want the opening matchups chosen instead ("I need to be able to pick the first
// set of matchups"), so an organizer can rearrange them - but only while the round is untouched.

// Round 1 is still safe to rewrite: nothing reported, nothing live, no veto acted on.
function swissRound1Open(t) {
  const r1 = (t.matches || []).filter(m => m.bracket === 'sw' && m.round === 1);
  if (!r1.length) return false;
  for (const m of r1) {
    if (m.status === 'done' || m.status === 'live') return false;
    if (Array.isArray(m.games) && m.games.length) return false;
    if (m.veto && ((m.veto.banned || []).length || (m.veto.picks || []).length)) return false;
    if (m.pendingReport) return false;
  }
  return true;
}

/**
 * Replace round 1 with the given pairs. Returns an error string, or null on success, plus the
 * ids of the matches it removed so the host can tidy anything keyed on them.
 * `pairs` is [[teamId, teamId], ...]; any team left over takes the bye.
 */
// Validate a proposed round 1 against the CURRENT field. Split out because the same check has
// to run twice: once when an organizer pins the matchups before the stage starts, and again
// when the stage actually starts, by which time the field may have changed.
// Returns { err } or { clean, left } - `left` being the at most one player who takes the bye.
function r1Check(t, pairs) {
  const ids = {};
  for (const team of t.teams) ids[team.id] = 0;
  const clean = [];
  for (const p of (pairs || [])) {
    if (!Array.isArray(p) || p.length !== 2) return { err: 'Every matchup needs exactly two players' };
    const [a, b] = p;
    if (a === b) return { err: 'A player cannot be matched against themselves' };
    for (const x of [a, b]) {
      if (!(x in ids)) return { err: 'Unknown player in the matchups' };
      if (ids[x]) return { err: 'A player appears in more than one matchup' };
      ids[x] = 1;
    }
    clean.push([a, b]);
  }
  const left = t.teams.filter(x => !ids[x.id]).map(x => x.id);
  if (left.length > 1) return { err: left.length + ' players are not in any matchup' };
  if (left.length === 1 && t.teams.length % 2 === 0) return { err: 'One player is not in any matchup' };
  if (!clean.length && !left.length) return { err: 'No matchups given' };
  return { clean, left };
}

// Pin the opening matchups BEFORE the stage starts. The editor used to exist only once round 1
// had been drawn, which left a race an organizer could not win: start the stage, and a player
// who opens their veto in the next few seconds locks the matchups for good. Planning ahead
// removes the race rather than papering over it.
function swissPlanRound1(t, pairs) {
  const v = r1Check(t, pairs);
  if (v.err) return v.err;
  t.plannedR1 = v.clean.map(p => p.slice());
  return null;
}
function swissShufflePlan(t) {
  const rnd = drawRng(t, 'plan-' + Date.now());
  const pool = shuffled(t.teams.map(x => x.id), rnd);
  const pairs = [];
  while (pool.length > 1) pairs.push([pool.shift(), pool.shift()]);
  t.plannedR1 = pairs;
  return null;
}
// Build round 1 from a plan. Returns false when the plan no longer fits the field - an
// organizer who reopened signups and added a player must get the normal draw, not a round
// that silently leaves somebody out.
function applyPlannedRound1(t, pairs) {
  const v = r1Check(t, pairs);
  if (v.err) return false;
  let idx = 0;
  for (const [a, b] of v.clean) {
    const m = newMatch(t, 'sw', 1, idx++, t.cfg.bo);
    m.team1 = a; m.team2 = b; m.status = 'ready';
    initMatchVetoes(t, m);
  }
  if (v.left.length === 1) {
    const bm = newMatch(t, 'sw', 1, 99, t.cfg.bo);
    bm.team1 = v.left[0]; bm.team2 = 'BYE'; bm.status = 'bye'; bm.winner = v.left[0]; bm.loser = 'BYE';
  }
  return true;
}

function swissSetRound1(t, pairs, removedOut) {
  if (!swissRound1Open(t)) return 'Round 1 has already started - the matchups are locked in';
  const v = r1Check(t, pairs);
  if (v.err) return v.err;
  const clean = v.clean, left = v.left;

  const removed = (t.matches || []).filter(m => m.bracket === 'sw' && m.round === 1).map(m => m.id);
  if (Array.isArray(removedOut)) for (const id of removed) removedOut.push(id);
  t.matches = (t.matches || []).filter(m => !(m.bracket === 'sw' && m.round === 1));
  let idx = 0;
  for (const [a, b] of clean) {
    const m = newMatch(t, 'sw', 1, idx++, t.cfg.bo);
    m.team1 = a; m.team2 = b; m.status = 'ready';
    initMatchVetoes(t, m);
  }
  if (left.length === 1) {
    const bm = newMatch(t, 'sw', 1, 99, t.cfg.bo);
    bm.team1 = left[0]; bm.team2 = 'BYE'; bm.status = 'bye'; bm.winner = left[0]; bm.loser = 'BYE';
  }
  return null;
}

// A fresh random round 1, for the "shuffle" button.
function swissShuffleRound1(t, removedOut) {
  const rnd = drawRng(t, 'r1-' + Date.now());
  const pool = shuffled(t.teams.map(x => x.id), rnd);
  const pairs = [];
  while (pool.length >= 2) pairs.push([pool.shift(), pool.shift()]);
  return swissSetRound1(t, pairs, removedOut);
}

// ---------- changing the matchups of the round being played (decision 81) ----------
// "There needs to be an option for the TD to manually adjust this or fix this somehow. There should
// NEVER be rematches in swiss!" (Prince round 3 of Setons, drawn before decision 80, paired two teams
// who had met in round 1.) The latest round of a Swiss can be paired again by an organizer: the teams
// of its matches nobody has started, and the bye, by hand or by the draw. Started matches stay as they
// are. Never two teams who have already played each other, and never a second bye while a team in it
// has not had one.

// Nothing has happened in it yet: no result, no live score, no game, no score waiting for the
// opponent, no map or faction choice (the host's matchTouched, the other way round).
function swissMatchUntouched(m) {
  if (swissMatchStarted(m)) return false;
  if (m.veto && ((m.veto.stepIndex || 0) > 0 || (m.veto.banned || []).length || (m.veto.picks || []).length)) return false;
  if (m.fveto && m.fveto.games) {
    for (const g of Object.values(m.fveto.games)) {
      for (const side of [g && g.t1, g && g.t2]) if (side && ((side.bans || []).length || (side.picks || []).length)) return false;
    }
  }
  return true;
}
// What round r of this Swiss (a division's view with divisions) leaves to pair again, or { err }:
//   ids    the teams of its matches not started and its bye, in the order of the table going into r
//   pairs  how they are paired now, bye  who has the bye now (or null)
//   keep   its matches that have started, rec  the records going into r, met  who has played whom
function swissRoundSetup(t, r) {
  if (!t.cfg || t.cfg.fast) return { err: 'Fast pairing pairs teams as they come free, so there is no round to change' };
  const last = swissMaxRound(t);
  if (!(r >= 2)) return { err: 'Round 1 has nothing to repeat; its matchups are set on the round 1 editor before the first result' };
  if (r !== last) return { err: 'Only the latest round can be changed (round ' + last + ')' };
  const inRound = t.matches.filter(m => m.bracket === 'sw' && m.round === r);
  const byeM = inRound.find(m => m.status === 'bye');
  const open = inRound.filter(m => m.status !== 'bye' && swissMatchUntouched(m));
  const keep = inRound.filter(m => m !== byeM && open.indexOf(m) < 0);
  if (!open.length) return { err: 'Every match of round ' + r + ' has started, so its matchups can no longer change' };
  // the table going into round r: its teams, the matches of the rounds before
  const before = Object.create(t);
  Object.defineProperty(before, 'matches', { value: t.matches.filter(m => m.bracket !== 'sw' || m.round < r), writable: true, enumerable: true });
  const rec = swissRecord(before);
  const order = swissSort(Object.values(rec), before, rec).map(x => x.teamId);
  const mine = new Set(open.flatMap(m => [m.team1, m.team2]).concat(byeM ? [byeM.team1] : []));
  return {
    round: r, ids: order.filter(id => mine.has(id)), keep, rec, met: swissPlayedPairs(before),
    pairs: open.map(m => [m.team1, m.team2]), bye: byeM ? byeM.team1 : null
  };
}
// A new pairing of round r (`pairs`, and `bye` when one is left over): null if it is fine, or why not.
function swissCheckRound(t, r, pairs, bye) {
  const s = swissRoundSetup(t, r);
  if (s.err) return s.err;
  const nm = id => ((t.teams || []).find(x => x.id === id) || {}).name || '?';
  const want = new Set(s.ids), seen = new Set();
  if (!Array.isArray(pairs)) return 'No matchups given';
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2) return 'Every matchup needs exactly two teams';
    if (p[0] === p[1]) return 'A team cannot play itself';
    for (const x of p) {
      if (!want.has(x)) return 'Only the teams of the matches not started yet (and the bye) can be paired again';
      if (seen.has(x)) return nm(x) + ' is in two matchups';
      seen.add(x);
    }
  }
  const left = s.ids.filter(id => !seen.has(id));
  if (left.length > 1 || (left.length === 1 && left[0] !== bye) || (bye && left.indexOf(bye) < 0)) {
    return s.ids.length % 2 ? 'One team has the bye, every other team plays exactly once' : 'Every team plays exactly once';
  }
  for (const [a, b] of pairs) {
    if (s.met[a + '|' + b]) {
      const old = t.matches.find(m => m.bracket === 'sw' && m.round < r && ((m.team1 === a && m.team2 === b) || (m.team1 === b && m.team2 === a)));
      return nm(a) + ' and ' + nm(b) + ' already played each other' + (old ? ' in round ' + old.round : '') + '. A Swiss never repeats a matchup.';
    }
  }
  if (bye && s.rec[bye] && s.rec[bye].byes) {
    const none = s.ids.filter(id => !(s.rec[id] && s.rec[id].byes));
    if (none.length) return nm(bye) + ' already had a bye. It goes to a team that has not had one: ' + none.map(nm).join(', ') + '.';
  }
  return null;
}
// Pair round r again (checked first). `removedOut` gets the ids of the matches it replaced.
function swissSetRound(t, r, pairs, bye, removedOut) {
  const err = swissCheckRound(t, r, pairs, bye);
  if (err) return err;
  const s = swissRoundSetup(t, r);
  const gone = t.matches.filter(m => m.bracket === 'sw' && m.round === r && s.keep.indexOf(m) < 0);
  const ids = new Set(gone.map(m => m.id));
  t.matches = t.matches.filter(m => !ids.has(m.id));
  if (Array.isArray(removedOut)) for (const id of ids) removedOut.push(id);
  const used = new Set(s.keep.map(m => m.index));
  let idx = 0;
  for (const [a, b] of pairs) {
    while (used.has(idx)) idx++;
    const m = newMatch(t, 'sw', r, idx++, swissBoFor(t, s.rec, a, b));
    m.team1 = a; m.team2 = b; m.status = 'ready';
    initMatchVetoes(t, m);
  }
  if (bye) swissGiveBye(t, bye, r);
  return null;
}
// The draw for what round r leaves to pair: down the table going into it, without a rematch.
function swissSuggestRound(t, r) {
  const s = swissRoundSetup(t, r);
  if (s.err) return { err: s.err };
  const d = classicDraw(s.ids, s.rec, s.met);
  return { pairs: d.pairs, bye: d.bye || null };
}

function swissMaxRound(t) {
  let r = 0;
  for (const m of t.matches) if (m.bracket === 'sw' && m.round > r) r = m.round;
  return r;
}

// Kept as-is for callers that only care about played/pending. Derived from the same walk
// as standings so the two can never drift.
function swissProgress(t) {
  const rec = swissRecord(t);
  const st = {};
  for (const team of t.teams) st[team.id] = { played: rec[team.id].played, pending: rec[team.id].pending };
  return st;
}

function swissGiveBye(t, teamId, round) {
  const bm = newMatch(t, 'sw', round, 99, t.cfg.bo);
  bm.team1 = teamId; bm.team2 = 'BYE'; bm.status = 'bye'; bm.winner = teamId; bm.loser = 'BYE';
}

// ---------- stage 2 ----------
// t.stage2 = { type:'single'|'double', cutTo:N, rounds:[bo...]|wb/lb/gf, lbHandicap, built }
// The playoff bracket is built from the qualified field only, using a separate seed field so
// the Swiss seeds (which came from rating) are left untouched and still readable.

function stageTwoCfg(t) {
  const s = t && t.stage2;
  if (!s || !s.cutTo) return null;
  return s;
}

// Who goes through. With cuts on that is everyone who cleared the win cut, in standings
// order; without cuts it is simply the top N of the standings.
function stageTwoField(t) {
  const s = stageTwoCfg(t);
  if (!s) return [];
  const cuts = swissCuts(t);
  const n = Math.max(2, parseInt(s.cutTo, 10) || 0);
  if (cuts.on && cuts.win) {
    const adv = swissAdvanced(t);
    if (adv.length >= n) return adv.slice(0, n);
    // Short field (forfeits): top up from the standings so the bracket can still be built.
    const rest = swissStandings(t).map(r => r.teamId).filter(id => adv.indexOf(id) < 0);
    return adv.concat(rest).slice(0, n);
  }
  return swissStandings(t).map(r => r.teamId).slice(0, n);
}

function stageTwoBuild(t, slots) {
  const s = stageTwoCfg(t);
  if (!s || s.built) return false;
  const field = stageTwoField(t);
  if (field.length < 2) return false;
  field.forEach((id, i) => {
    const tm = t.teams.find(x => x.id === id);
    if (tm) tm.stage2Seed = i + 1;
  });
  const opts = { only: field, seedKey: 'stage2Seed' };
  if (Array.isArray(slots) && slots.length) opts.slots = slots;
  if (s.type === 'double') {
    buildDouble(t, {
      wb: s.wb, lb: s.lb, gf: s.gf, lbHandicap: s.lbHandicap ? 1 : 0
    }, 0, opts);
  } else {
    // thirdPlace: the two beaten semi-finalists play for 3rd (lib/match addThirdPlace)
    buildSingle(t, { rounds: s.rounds, thirdPlace: s.thirdPlace ? 1 : 0, thirdBo: s.thirdBo || 0 }, 0, opts);
  }
  s.built = Date.now();
  s.field = field.slice();
  return true;
}

// ---------- deciders for the final (decision 80) ----------
// The final is the top two of the table. When teams finish level on record for a place in it, the
// tiebreak used to pick who went through: "its unfair if one team 2-1 gets picked over the other
// so it should be decided by a deciding game". Now the teams level on record with the second place
// play deciders (bracket 'dc', as long as a Swiss round) for the place(s) left, and the final waits
// for them:
//   2 teams for 1 place   one decider, the winner goes through;
//   3 teams for 2 places  the best two play, the winner goes through; the loser plays the third
//                         for the other place, so nobody reaches the final without a win;
//   anything else         a knockout among them (two halves for two places).
// "Best" is the table's own order (game difference, then seed, or the beaten tiebreak): it decides
// who meets whom and who waits a round, never who goes through. Four of them are paired without a
// rematch when that can be done. Nothing about the deciders is stored but the matches themselves:
// who plays which one is worked out from the table and the decider results each time, and a decider
// or final that no longer fits them (a result was corrected) is taken back while it has not started.

// A match that must never be taken back: a result, a live score, a game or a score on record.
function swissMatchStarted(m) {
  return !!m && (m.status === 'done' || m.status === 'live' || !!m.pendingReport || (Array.isArray(m.games) && m.games.length > 0));
}
// Take matches back that have not started (the host tidies what hung off them: chat, pools).
function takeBack(t, list) {
  const gone = new Set(list.filter(m => !swissMatchStarted(m)).map(m => m.id));
  if (!gone.size) return;
  t.matches = t.matches.filter(m => !gone.has(m.id));
  if (hooks.removedMatches) hooks.removedMatches(wholeOf(t), Array.from(gone));
}
const sameTwo = (m, ids) => !!ids && ids.length === 2 && ((m.team1 === ids[0] && m.team2 === ids[1]) || (m.team1 === ids[1] && m.team2 === ids[0]));
// The teams level on record with the second place of a finished table, if there are more of them
// than places left in the final: { ids (table order), spots, above (in the final already), rec }.
function deciderField(standings) {
  if (standings.length < 3) return null;
  const cut = standings[1];
  const level = r => r.wins === cut.wins && r.losses === cut.losses;
  const first = standings.findIndex(level);
  const ids = standings.filter(level).map(r => r.teamId);
  const spots = 2 - first;
  if (ids.length <= spots) return null;
  return { ids, spots, above: standings.slice(0, first).map(r => r.teamId), rec: cut.wins + '-' + cut.losses };
}
// Seed order of a bracket of P (a power of two): [1, 4, 2, 3] for 4.
function bracketOrder(P) {
  let order = [1];
  while (order.length < P) {
    const next = [], m = order.length * 2;
    for (const s of order) { next.push(s); next.push(m + 1 - s); }
    order = next;
  }
  return order;
}
// A knockout among `ids` (best first): its games { key, round, src } and where its winner comes
// from. A source is a team id, { w: key } or { l: key } (the winner / loser of that game). The best
// wait a round when the number is no power of two.
function knockout(ids, tag) {
  let P = 1;
  while (P < ids.length) P *= 2;
  let slots = bracketOrder(P).map(s => (s <= ids.length ? ids[s - 1] : null));
  const games = [];
  for (let r = 1; slots.length > 1; r++) {
    const next = [];
    for (let i = 0; i < slots.length; i += 2) {
      const a = slots[i], b = slots[i + 1];
      if (a == null || b == null) { next.push(a == null ? b : a); continue; }
      const key = tag + r + '.' + (i / 2);
      games.push({ key, round: r, src: [a, b] });
      next.push({ w: key });
    }
    slots = next;
  }
  return { games, winner: slots[0] };
}
// The deciders for a field: { games, out } - `out` the sources of the places in the final.
function deciderPlan(field, played) {
  let ids = field.ids.slice();
  if (ids.length === 4) {
    // 1st v 4th and 2nd v 3rd, unless one of those is a rematch: then 1st v 3rd and 2nd v 4th,
    // then 1st v 2nd and 3rd v 4th (the order below puts each option's pairs at 1-4 and 2-3)
    const [a, b, c, d] = ids;
    const met = (x, y) => !!played[x + '|' + y];
    const options = [[a, b, c, d], [a, b, d, c], [a, c, d, b]];
    ids = options.find(o => !met(o[0], o[3]) && !met(o[1], o[2])) || options[0];
  }
  if (field.spots === 1) {
    const k = knockout(ids, 'k');
    return { games: k.games, out: [k.winner] };
  }
  if (ids.length === 3) {
    return { games: [{ key: 'a1', round: 1, src: [ids[0], ids[1]] }, { key: 'b2', round: 2, src: [{ l: 'a1' }, ids[2]] }], out: [{ w: 'a1' }, { w: 'b2' }] };
  }
  const A = [], B = [];
  ids.forEach((id, i) => ((i % 4 === 0 || i % 4 === 3) ? A : B).push(id));
  const ka = knockout(A, 'a'), kb = knockout(B, 'b');
  return { games: ka.games.concat(kb.games), out: [ka.winner, kb.winner] };
}
function swissPlayedPairs(t) {
  const played = {};
  for (const m of t.matches) {
    if (m.bracket === 'sw' && m.team1 && m.team2 && m.team1 !== 'BYE' && m.team2 !== 'BYE') {
      played[m.team1 + '|' + m.team2] = 1;
      played[m.team2 + '|' + m.team1] = 1;
    }
  }
  return played;
}
// The two finalists of a finished Swiss, best first, or null while deciders are still to be played.
// Draws every decider whose two teams are known and is not drawn yet; takes back one not started
// that no longer fits.
function swissFinalists(t) {
  const standings = swissStandings(t);
  if (standings.length < 2) return null;
  const ds = t.matches.filter(m => m.bracket === 'dc');
  const field = deciderField(standings);
  if (!field) {
    takeBack(t, ds);
    return [standings[0].teamId, standings[1].teamId];
  }
  const plan = deciderPlan(field, swissPlayedPairs(t));
  const pos = {}, perRound = {};
  for (const g of plan.games) { pos[g.key] = perRound[g.round] || 0; perRound[g.round] = pos[g.key] + 1; }
  const byKey = {}, keep = new Set();
  const teamOf = s => {
    if (typeof s === 'string') return s;
    const m = s && byKey[s.w || s.l];
    if (!m || m.status !== 'done' || !m.winner) return null;
    return s.w ? m.winner : m.loser;
  };
  // earlier rounds first: a game's teams come from games of earlier rounds
  for (const g of plan.games.slice().sort((x, y) => x.round - y.round || pos[x.key] - pos[y.key])) {
    const want = g.src.map(teamOf);
    const have = ds.find(m => m.dkey === g.key && !keep.has(m));
    if (have && (swissMatchStarted(have) || (want[0] && want[1] && sameTwo(have, want)))) { byKey[g.key] = have; keep.add(have); continue; }
    if (!want[0] || !want[1]) continue;
    const m = newMatch(t, 'dc', g.round, pos[g.key], t.cfg.bo);
    m.team1 = want[0]; m.team2 = want[1]; m.status = 'ready'; m.dkey = g.key;
    initMatchVetoes(t, m);
    byKey[g.key] = m; keep.add(m);
  }
  takeBack(t, ds.filter(m => !keep.has(m)));
  const won = plan.out.map(teamOf);
  if (won.some(x => !x)) return null;
  const at = {};
  standings.forEach((r, i) => { at[r.teamId] = i; });
  return field.above.concat(won).sort((a, b) => at[a] - at[b]);
}
// Who plays (or played) deciders for the final, division by division: [{ division, ids, spots,
// above, rec }], or null. For the page and the log.
function swissDeciderInfo(t) {
  if (!t || t.bracketType !== 'swiss' || !t.cfg || !t.cfg.final || stageTwoCfg(t)) return null;
  const n = swissDivisionCount(t);
  const out = [];
  for (let d = n ? 1 : 0; d <= n; d++) {
    const v = n ? divisionView(t, d) : t;
    if (!v.teams.length || !v.matches.some(m => m.bracket === 'sw') || !swissStageDone(v)) continue;
    // a final drawn before deciders existed was drawn from the top two, and stays so
    const gf = v.matches.find(m => m.bracket === 'gf');
    if (gf && !gf.fromTable) continue;
    const f = deciderField(swissStandings(v));
    if (f) out.push(Object.assign({ division: d }, f));
  }
  return out.length ? out : null;
}

// ---------- completion ----------

function swissStageDone(t) {
  const cuts = swissCuts(t);
  const rec = swissRecord(t);
  if (cuts.on) {
    // decided when nobody is still active and nothing is outstanding
    for (const team of t.teams) {
      const r = rec[team.id];
      if (r.state === 'active') return false;
      if (r.pending) return false;
    }
    return true;
  }
  return !t.teams.some(x => rec[x.id].played < t.cfg.rounds);
}

// With divisions every division finishes on its own; true when all of them are done.
function swissFinishIfDone(t) {
  const n = swissDivisionCount(t);
  if (!n) return finishOne(t);
  let all = true;
  for (let d = 1; d <= n; d++) if (!finishOne(divisionView(t, d))) all = false;
  return all;
}
function finishOne(t) {
  if (!swissStageDone(t)) {
    // A corrected result reopened the stage: deciders and a final drawn from the old table go
    // (not one that has started: the host refuses such a correction).
    if (t.cfg && t.cfg.final) takeBack(t, t.matches.filter(m => m.bracket === 'dc' || (m.bracket === 'gf' && m.fromTable)));
    return false;
  }
  const s2 = stageTwoCfg(t);
  if (s2) {
    // When the playoff field picks its own matchups, the host opens that phase first and calls
    // stageTwoBuild itself once every pick is in. hooks.openStagePicks returns true if it took
    // over; nothing here knows how the pick phase works, only that it may exist.
    if (s2.pickPhase && !s2.built && hooks.openStagePicks && hooks.openStagePicks(t, stageTwoField(t))) return true;
    stageTwoBuild(t);        // no-op once built; the bracket crowns the champion from here
    return true;
  }
  if (t.cfg.final) {
    // The top two play the final; when the second place is shared, after the deciders. A final
    // drawn before deciders existed (no fromTable) stays exactly as it was drawn.
    let gf = t.matches.find(m => m.bracket === 'gf');
    if (gf && !gf.fromTable) return true;
    const fin = swissFinalists(t);
    if (gf && !swissMatchStarted(gf) && !sameTwo(gf, fin)) { takeBack(t, [gf]); gf = null; }
    if (!gf && fin) {
      gf = newMatch(t, 'gf', 1, 0, t.cfg.finalBo);
      gf.team1 = fin[0]; gf.team2 = fin[1]; gf.status = 'ready'; gf.fromTable = 1;
    }
  } else if (t.swissDivision) {
    // a division without a final: the top of its table is its champion (swissDivisionChampion).
    // The tournament is over once every division is, and its champion is the top division's.
    const all = wholeOf(t);
    const n = parseInt(all.divisions, 10) || 0;
    let done = n > 0;
    for (let d = 1; d <= n; d++) if (!divisionChampion(all, d)) done = false;
    if (done) {
      all.championTeamId = divisionChampion(all, 1);
      all.status = 'finished';
    }
  } else if (!t.championTeamId) {
    const top = swissStandings(t);
    t.championTeamId = top[0].teamId;
    t.status = 'finished';
  }
  return true;
}

function swissAfterReport(t) {
  const n = swissDivisionCount(t);
  if (n) {
    // every division moves on by itself: a round, a pairing or a final where it is due
    for (let d = 1; d <= n; d++) swissAfterReport(divisionView(t, d));
    return;
  }
  if (swissFinishIfDone(t)) return;
  const cuts = swissCuts(t);

  if (cuts.on) {
    // Record cuts pair a whole round at a time. Everyone still active plays in every round,
    // so the score groups stay aligned and the draw can always stay inside a group. Eager
    // pairing cannot do that: it would pair whichever two players happened to finish first,
    // which in practice means re-pairing the two who just played each other.
    const maxR = swissMaxRound(t);
    const open = t.matches.some(m => m.bracket === 'sw' && m.round === maxR &&
      (m.status === 'ready' || m.status === 'live' || m.status === 'waiting'));
    if (open) return;
    const rec = swissRecord(t);
    const active = t.teams.filter(x => rec[x.id].state === 'active');
    if (active.length && maxR < t.cfg.rounds) swissPairRound(t, maxR + 1);
    swissFinishIfDone(t);
    return;
  }

  if (t.cfg.fast) {
    // eager pairing: match up free teams as soon as possible - but never two who have already
    // played each other while another team is still playing (decision 62). The two who just
    // finished a match are always free together, so pairing whoever was free put them straight
    // back against each other: in a 4-team stage every pair played three times.
    for (let guard = 0; guard < 200; guard++) {
      const rec = swissRecord(t);
      const standingsOrder = swissSort(Object.values(rec), t, rec).map(x => x.teamId);
      const pos = {};
      standingsOrder.forEach((id, i) => { pos[id] = i; });
      const pool = t.teams
        .filter(x => rec[x.id].played < t.cfg.rounds && !rec[x.id].pending)
        .map(x => x.id)
        .sort((a, b) => (rec[a].played - rec[b].played) || (pos[a] - pos[b]));
      if (pool.length >= 2) {
        const playedPairs = {};
        for (const m of t.matches) {
          if (m.bracket === 'sw' && m.team1 && m.team2 && m.team1 !== 'BYE' && m.team2 !== 'BYE') {
            playedPairs[m.team1 + '|' + m.team2] = 1;
            playedPairs[m.team2 + '|' + m.team1] = 1;
          }
        }
        // The first free team, in that order, that has a free opponent it has not met yet, and
        // the first such opponent - the pool is sorted by games played, so one with as many games
        // as it has if there is one.
        let a = null, b = null, forced = false;
        for (const x of pool) {
          const fresh = pool.filter(y => y !== x && !playedPairs[x + '|' + y]);
          if (!fresh.length) continue;
          a = x;
          b = fresh[0];
          break;
        }
        if (!a) {
          // Every free team has already met every other free team. Wait for the teams still
          // playing that will need another game after this one: a fresh opponent is on the way.
          // Only when nobody else can come free does it repeat a pairing, rather than stall.
          const othersPlaying = t.teams.some(x => pool.indexOf(x.id) < 0 && rec[x.id].pending && rec[x.id].played + 1 < t.cfg.rounds);
          if (othersPlaying) break;
          a = pool[0];
          b = pool[1];
          forced = true;
        }
        const m = newMatch(t, 'sw', Math.min(rec[a].played, rec[b].played) + 1, 98, swissBoFor(t, rec, a, b));
        m.team1 = a; m.team2 = b; m.status = 'ready';
        // a repeat the stage could not avoid: marked, so the host never takes it back
        if (forced && playedPairs[a + '|' + b]) m.repeat = 1;
        initMatchVetoes(t, m);
        continue; // try to pair more
      }
      if (pool.length === 1) {
        const lonely = pool[0];
        const othersPending = t.teams.some(x => x.id !== lonely &&
          rec[x.id].played < t.cfg.rounds && rec[x.id].pending);
        if (!othersPending) {
          // A bye is a free win. Under cuts that can carry a team over the win cut, so it is
          // only ever handed out when literally nobody else is available to play them.
          swissGiveBye(t, lonely, rec[lonely].played + 1);
          if (swissFinishIfDone(t)) return;
          continue;
        }
      }
      break;
    }
    swissFinishIfDone(t);
    return;
  }

  // classic: next round only when the current one is fully done
  const maxR = swissMaxRound(t);
  const open = t.matches.some(m => m.bracket === 'sw' && m.round === maxR &&
    (m.status === 'ready' || m.status === 'live' || m.status === 'waiting'));
  if (open) return;
  if (maxR < t.cfg.rounds) { swissPairRound(t, maxR + 1); return; }
  swissFinishIfDone(t);
}

module.exports = {
  swissStandings, swissPairRound, swissMaxRound, swissProgress, swissGiveBye,
  swissFinishIfDone, swissAfterReport,
  swissCuts, swissCutRounds, swissRecord, swissActive, swissAdvanced, swissBoFor,
  swissPlanRound1, swissShufflePlan, r1Check, swissTiebreakMode, swissTiebreakValues,
  swissStageDone, stageTwoCfg, stageTwoField, stageTwoBuild, setSwissHooks,
  swissRound1Open, swissSetRound1, swissShuffleRound1, recordsBefore,
  swissDivisionCount, swissDivisionView: divisionView, swissDivisionChampion,
  swissDeciderInfo, swissMatchStarted,
  swissRoundSetup, swissCheckRound, swissSetRound, swissSuggestRound, swissMatchUntouched,
};
