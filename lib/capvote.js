// NOTE: not yet `// @ts-check` (untyped dynamic tournament objects, like lib/teams.js).
// Captains chosen by a vote of the players (decision 74). One round per captain, in seed order:
// round 1 elects the seed 1 captain, round 2 the seed 2 captain, and so on, each among the
// candidates not elected yet. Every voter has one vote per round and can change it until the
// round's time is up; nothing locks earlier, even when everyone has voted. The most votes wins; a
// tie (or nobody voting) goes to the higher rating, then the earlier signup. The organizer can
// pause, add time, end a round now or cancel the vote.
//
// Everything runs on the server's clock: sweep() closes whatever has run out whenever the
// tournament is next read or written, so a vote nobody is watching still ends on time, rounds
// that ran out while nobody looked are closed in order at their own end times, and nothing waits
// on a page being open. With "show votes live" off, a ballot never leaves the server except to
// its own voter, and a closed round keeps only its counts.
'use strict';

const { playerById } = require('./util');
const { buildDraft, finishDraftIfDone, draftable, draftNoShows } = require('./teams');

// One minute of vote time. Tests shorten it (VOTE_MINUTE_MS); nothing else should.
function minuteMs() { const v = parseInt(process.env.VOTE_MINUTE_MS, 10); return v > 0 ? v : 60000; }

// t.capVotes is keyed by the division the vote is for (0 = a tournament without divisions).
function vkey(d) { return String(parseInt(d, 10) || 0); }
function numIn(v, lo, hi, dflt) { const n = parseInt(v, 10); return isFinite(n) && n >= lo && n <= hi ? n : dflt; }

// Division d's vote settings, with their defaults. Division 1 (or a tournament without divisions)
// keeps them in t.voteCfg next to t.captainCount; a later division in t.divCaptains[d].vote next
// to its own count.
function voteCfgOf(t, d) {
  const dv = parseInt(d, 10) || 0;
  const div = dv > 1 ? ((t.divCaptains || {})[dv] || {}) : null;
  const raw = (div ? div.vote : t.voteCfg) || {};
  const count = parseInt(div ? div.count : t.captainCount, 10) || 0;
  return {
    count,
    voters: numIn(raw.voters, 0, 999, 0),                              // 0 = everyone who can vote
    candidates: numIn(raw.candidates, 2, 999, count >= 2 ? count * 2 : 0),
    minutes: numIn(raw.minutes, 1, 60, 5),
    live: raw.live ? 1 : 0,
    autoDraft: raw.autoDraft === 0 ? 0 : 1,                            // the draft starts when the vote ends
    autoStart: raw.autoStart === 0 ? 0 : 1,                            // a later division's vote starts by itself
    include: Array.isArray(raw.include) ? raw.include.slice() : [],    // put in the candidates by hand
    exclude: Array.isArray(raw.exclude) ? raw.exclude.slice() : []     // taken out of them by hand
  };
}
// The settings as stored, cleaned (what set_captain_mode keeps).
function cleanVoteCfg(b, prev) {
  const p = prev || {};
  const out = Object.assign({}, p);
  if (b.voters !== undefined) out.voters = numIn(b.voters, 0, 999, 0);
  if (b.candidates !== undefined) { const n = numIn(b.candidates, 2, 999, null); if (n == null) return { error: 'The players who can be voted for must be a number from 2 to 999' }; out.candidates = n; }
  if (b.minutes !== undefined) { const n = numIn(b.minutes, 1, 60, null); if (n == null) return { error: 'The vote time per captain must be 1 to 60 minutes' }; out.minutes = n; }
  if (b.live !== undefined) out.live = b.live ? 1 : 0;
  if (b.autoDraft !== undefined) out.autoDraft = b.autoDraft ? 1 : 0;
  if (b.autoStart !== undefined) out.autoStart = b.autoStart ? 1 : 0;
  return { cfg: out };
}

// Rating, highest first; equal ratings by signup, earliest first. Never re-sorts the array given.
function byRating(t, list) {
  const idx = {};
  (t.players || []).forEach((p, i) => { idx[p.id] = i; });
  return list.slice().sort((a, b) => ((b.rating || 0) - (a.rating || 0)) || ((idx[a.id] || 0) - (idx[b.id] || 0)));
}

// Who takes part in division d's vote. Division 1 (or none): every approved player, without the
// ones the ready check leaves out (decision 54: worked out the same way before the start, marked
// noShow by it). A later division: the players nobody has drafted.
function votePool(t, d) {
  const dv = parseInt(d, 10) || 0;
  if (dv > 1) return (t.players || []).filter(draftable);
  const out = {};
  for (const p of draftNoShows(t)) out[p.id] = 1;
  return (t.players || []).filter(p => !p.pending && !p.noShow && !out[p.id] && !p.teamId);
}

// The voters and candidates division d's vote has (or would have, if it started now), plus what
// is wrong with the hand-made changes. Voters need a FAF account: the vote is cast by login.
function voteLists(t, d, cfg) {
  const c = cfg || voteCfgOf(t, d);
  const pool = byRating(t, votePool(t, d));
  const inPool = {};
  pool.forEach(p => { inPool[p.id] = 1; });
  const canVote = pool.filter(p => p.fafId);
  const voters = c.voters > 0 ? canVote.slice(0, c.voters) : canVote;
  const exclude = {};
  for (const id of c.exclude) exclude[id] = 1;
  const added = [], problems = [];
  for (const id of c.include) {
    const p = playerById(t, id);
    if (!p || added.indexOf(p) >= 0) continue;    // gone (withdrew, removed): nothing to put in
    if (!inPool[id]) {
      problems.push(p.name + ', put in the vote by hand, ' + (p.teamId ? 'is already on a team' : p.pending ? 'was never approved'
        : 'has not checked in, so cannot be voted for') + '. Replace them, or check them in on the Players list.');
      continue;
    }
    added.push(p);
  }
  const rest = pool.filter(p => !exclude[p.id] && added.indexOf(p) < 0);
  const candidates = byRating(t, added.concat(rest.slice(0, Math.max(0, c.candidates - added.length))));
  return { voters, candidates, pool, problems, cfg: c };
}

// Why division d's vote cannot start now (null: it can).
function voteStartError(t, d, L) {
  const c = L.cfg;
  if (c.count < 2) return 'Set how many captains there should be first';
  if (c.candidates <= c.count) return 'The players who can be voted for must be more than the captains (' + (c.count + 1) + ' or more for ' + c.count + ' captains)';
  if (L.problems.length) return L.problems[0];
  if (L.candidates.length <= c.count) {
    return 'Only ' + L.candidates.length + ' player' + (L.candidates.length === 1 ? '' : 's') + ' can be voted for; ' + (c.count + 1) + ' are needed for ' + c.count + ' captains';
  }
  if (!L.voters.length) return 'Nobody can vote: voting needs a FAF account, and none of the players in it has one';
  return null;
}

// Still in the vote: in the tournament (a removed player is gone from t.players), not on a team.
function stillIn(t, id) { const p = playerById(t, id); return !!p && !p.pending && !p.teamId; }
// The candidates the next round is between: still in, not elected yet.
function remaining(t, v) {
  const taken = {};
  v.seats.forEach(id => { if (id) taken[id] = 1; });
  return v.candidateIds.filter(id => !taken[id] && stillIn(t, id));
}
// No candidate left for a seat: the highest rated player left in the vote's pool takes it.
function fillPick(t, v) {
  const taken = {};
  v.seats.forEach(id => { if (id) taken[id] = 1; });
  const pool = byRating(t, votePool(t, v.division)).filter(p => !taken[p.id]);
  return pool.length ? pool[0].id : null;
}

// Fill the seats that need no vote (one candidate left: theirs; none: the highest rated player
// left), then open a round for the lowest empty seat. All seats filled: the vote is done.
function openNext(t, v, at, events) {
  for (;;) {
    const seat = v.seats.indexOf(null);
    if (seat < 0) { v.round = null; v.state = 'done'; v.endedAt = at; events.push({ kind: 'done', v }); return; }
    const left = remaining(t, v);
    if (left.length >= 2) {
      // `n` numbers the rounds: a vote sent for a round that has closed meanwhile is refused,
      // never counted in the next one
      v.roundNo = (v.roundNo || 0) + 1;
      v.round = { n: v.roundNo, seat, startedAt: at, endsAt: at + v.cfg.minutes * minuteMs(), ballots: {} };
      return;
    }
    const winner = left.length ? left[0] : fillPick(t, v);
    if (!winner) { v.round = null; v.state = 'failed'; v.endedAt = at; events.push({ kind: 'failed', v }); return; }
    const res = { seat, winner, how: left.length ? 'only' : 'fill', counts: {}, votes: 0, voters: v.voterIds.length, at };
    v.seats[seat] = winner;
    v.results.push(res);
    events.push({ kind: 'seat', v, res });
  }
}

// Count the current round (ballots for candidates still in, from voters still in), elect its
// winner and go on. `at` is the round's own end time, or now when the organizer ends it.
function closeRound(t, v, at, events) {
  const r = v.round;
  const left = remaining(t, v);
  const voterIn = {};
  v.voterIds.forEach(id => { if (playerById(t, id)) voterIn[id] = 1; });
  const counts = {};
  left.forEach(id => { counts[id] = 0; });
  let total = 0;
  for (const voter of Object.keys(r.ballots)) {
    const cand = r.ballots[voter];
    if (!voterIn[voter] || counts[cand] == null) continue;
    counts[cand]++;
    total++;
  }
  let winner, how;
  if (!left.length) { winner = fillPick(t, v); how = 'fill'; }
  else {
    const max = Math.max.apply(null, left.map(id => counts[id]));
    const top = left.filter(id => counts[id] === max);
    winner = byRating(t, top.map(id => playerById(t, id)))[0].id;
    how = total === 0 ? 'none' : (top.length > 1 ? 'tie' : 'votes');
  }
  const res = { seat: r.seat, winner, how, counts, votes: total, voters: Object.keys(voterIn).length, at };
  // with live votes everyone saw them all along; otherwise only the counts outlive the round
  if (v.cfg.live) res.ballots = Object.assign({}, r.ballots);
  v.round = null;
  if (!winner) { v.state = 'failed'; v.endedAt = at; events.push({ kind: 'failed', v }); return; }
  v.seats[r.seat] = winner;
  v.results.push(res);
  events.push({ kind: 'seat', v, res });
  openNext(t, v, at, events);
}

// Is v the vote of the division whose captains are being chosen right now?
function isCurrent(t, v) {
  return t.status === 'draft' && !!t.draft && !!t.draft.voting && (parseInt(t.draft.division, 10) || 0) === v.division;
}
function currentVote(t) {
  if (!(t.status === 'draft' && t.draft && t.draft.voting) || !t.capVotes) return null;
  return t.capVotes[vkey(t.draft.division)] || null;
}

// Start division d's vote now. Returns an error message, or null; nothing changes on an error.
function startVote(t, d, now, events) {
  const dv = parseInt(d, 10) || 0;
  const L = voteLists(t, dv);
  const err = voteStartError(t, dv, L);
  if (err) return err;
  const c = L.cfg;
  const v = {
    division: dv,
    cfg: { count: c.count, voters: c.voters, candidates: c.candidates, minutes: c.minutes, live: c.live, autoDraft: c.autoDraft },
    voterIds: L.voters.map(p => p.id),
    candidateIds: L.candidates.map(p => p.id),
    seats: new Array(c.count).fill(null),
    results: [],
    state: 'open',
    startedAt: now,
    round: null
  };
  t.capVotes = t.capVotes || {};
  t.capVotes[vkey(dv)] = v;
  t.draft = dv ? { order: [], current: 0, division: dv, voting: 1 } : { order: [], current: 0, voting: 1 };
  t.status = 'draft';
  t.pendingCaptains = [];
  events.push({ kind: 'started', v });
  openNext(t, v, now, events);
  return null;
}

// The vote is over: the elected captains draft, in the vote's order (seat 1 = seed 1).
function startDraftFrom(t, v, events) {
  const seats = v.seats.slice();
  if (seats.some(id => !id || !stillIn(t, id))) return "A captain's seat is empty";
  buildDraft(t, seats, v.division, { keepOrder: 1 });
  v.state = 'drafting';
  events.push({ kind: 'drafting', v });
  finishDraftIfDone(t);
  return null;
}

// The vote could not elect every captain (players removed until nobody was left for a seat): the
// first division goes back to signups, a later one waits for the organizer.
function failVote(t, v, events) {
  delete t.capVotes[vkey(v.division)];
  if (v.division > 1) t.draft = { order: [], current: 0, division: v.division, waiting: 1 };
  else { t.draft = null; t.status = 'signup'; for (const p of t.players) delete p.noShow; }
  events.push({ kind: 'failedBack', v });
}

// Apply the clock (and the follow-ups of what it closes) to tournament t. Safe to call anywhere,
// any number of times. Returns what happened, for the messages.
function sweep(t, now) {
  const events = [];
  // a later division set to vote, waiting since its draft chain reached it: start it now if it is
  // to start by itself, otherwise it stays with the organizer
  if (t.status === 'draft' && t.draft && t.draft.waiting && t.draft.voteNext) {
    const d = parseInt(t.draft.division, 10) || 0;
    delete t.draft.voteNext;
    if (voteCfgOf(t, d).autoStart) {
      const err = startVote(t, d, now, events);
      if (err) events.push({ kind: 'autoFail', division: d, error: err });
    } else events.push({ kind: 'awaitOrganizer', division: d });
  }
  if (!t.capVotes) return events;
  for (const k of Object.keys(t.capVotes)) {
    const v = t.capVotes[k];
    while (v.state === 'open' && v.round && v.round.endsAt <= now) closeRound(t, v, v.round.endsAt, events);
    if (!isCurrent(t, v)) continue;
    if (v.state === 'done' && v.cfg.autoDraft) startDraftFrom(t, v, events);
    else if (v.state === 'failed') failVote(t, v, events);
  }
  return events;
}

// A voter's vote for round `roundNo` (candidateId null takes it back). The round has to be the one
// still open: a vote that arrives after its round closed is refused, not moved to the next one.
function castVote(t, voterId, candidateId, roundNo, now) {
  const v = currentVote(t);
  if (!v) return 'No captain vote is running';
  if (v.state === 'paused') return 'The vote is paused';
  if (v.state !== 'open' || !v.round || now >= v.round.endsAt || (roundNo != null && parseInt(roundNo, 10) !== v.round.n)) {
    return 'Voting for that captain has closed';
  }
  if (!voterId || v.voterIds.indexOf(voterId) < 0) return 'You are not one of the voters';
  if (candidateId == null || candidateId === '') { delete v.round.ballots[voterId]; return null; }
  if (remaining(t, v).indexOf(candidateId) < 0) return 'That player cannot be voted for';
  v.round.ballots[voterId] = candidateId;
  return null;
}

// The organizer's controls on the running vote: pause, resume, add minutes, end the round now.
// `roundNo`: the round the organizer was looking at; if it has closed meanwhile (its time ran out,
// another organizer ended it) the control is refused rather than applied to the next round.
function controlVote(t, op, now, minutes, events, roundNo) {
  const v = currentVote(t);
  if (!v) return 'No captain vote is running';
  if (roundNo != null && (!v.round || parseInt(roundNo, 10) !== v.round.n)) return 'That round is already over';
  if (op === 'pause') {
    if (v.state !== 'open' || !v.round) return 'The vote is not running';
    v.round.left = Math.max(0, v.round.endsAt - now);
    v.state = 'paused';
    return null;
  }
  if (op === 'resume') {
    if (v.state !== 'paused' || !v.round) return 'The vote is not paused';
    v.round.endsAt = now + (v.round.left || 0);
    delete v.round.left;
    v.state = 'open';
    return null;
  }
  if (op === 'add') {
    const n = numIn(minutes, 1, 60, null);
    if (n == null) return 'Add 1 to 60 minutes';
    if (!v.round || (v.state !== 'open' && v.state !== 'paused')) return 'No round is running';
    if (v.state === 'paused') v.round.left = (v.round.left || 0) + n * minuteMs();
    else v.round.endsAt += n * minuteMs();
    return null;
  }
  if (op === 'end') {
    if (!v.round || (v.state !== 'open' && v.state !== 'paused')) return 'No round is running';
    if (v.state === 'paused') { delete v.round.left; v.state = 'open'; }
    closeRound(t, v, now, events);
    return null;
  }
  return 'Unknown control';
}

// Cancel the vote of the division whose captains are being chosen. The first division goes back to
// signups (its settings stay, ready to start again); a later one waits for the organizer.
function cancelVote(t) {
  const v = currentVote(t);
  if (!v) return 'No captain vote is running';
  delete t.capVotes[vkey(v.division)];
  if (v.division > 1) t.draft = { order: [], current: 0, division: v.division, waiting: 1 };
  else { t.draft = null; t.status = 'signup'; for (const p of t.players) delete p.noShow; }
  t.pendingCaptains = [];
  return null;
}

// The vote is over and waits for the organizer to start the draft: they may give an elected
// captain's seat to another player of the vote's pool (someone who does not want to captain).
function replaceSeat(t, seat, inId) {
  const v = currentVote(t);
  if (!v || v.state !== 'done') return 'Captains can be replaced once the vote is over, before the draft starts';
  const s = parseInt(seat, 10);
  if (!(s >= 0 && s < v.seats.length)) return 'No such captain';
  const pool = votePool(t, v.division);
  if (!pool.some(p => p.id === inId)) return 'That player is not in this draft';
  if (v.seats.indexOf(inId) >= 0) return 'That player is already a captain';
  const was = v.seats[s];
  v.seats[s] = inId;
  const res = v.results.filter(x => x.seat === s).pop();
  if (res) { res.replaced = was; res.winner = inId; }
  return null;
}

// A player left the tournament while a vote of theirs is going (an organizer removed them): their
// vote is dropped, and so are the votes for them; a captain already elected frees their seat, which
// is voted again (straight away if the vote was already over).
function playerRemoved(t, pid, now) {
  const events = [];
  for (const k of Object.keys(t.capVotes || {})) {
    const v = t.capVotes[k];
    if (v.state !== 'open' && v.state !== 'paused' && v.state !== 'done') continue;
    v.voterIds = v.voterIds.filter(id => id !== pid);
    v.candidateIds = v.candidateIds.filter(id => id !== pid);
    if (v.round) {
      delete v.round.ballots[pid];
      for (const voter of Object.keys(v.round.ballots)) if (v.round.ballots[voter] === pid) delete v.round.ballots[voter];
    }
    const i = v.seats.indexOf(pid);
    if (i >= 0) {
      v.seats[i] = null;
      events.push({ kind: 'seatFreed', v, seat: i });
      if (v.state === 'done') { v.state = 'open'; openNext(t, v, now, events); }
    }
  }
  return events;
}

// Before the vote starts: give a candidate's place to another player of the pool, chosen by hand.
// `include` holds the players put in by hand, `exclude` the ones taken out. Returns the new
// settings object (to store) or { error }.
function swapCandidate(t, d, outId, inId) {
  const dv = parseInt(d, 10) || 0;
  const c = voteCfgOf(t, dv);
  const L = voteLists(t, dv, c);
  if (!L.candidates.some(p => p.id === outId)) return { error: 'That player is not one of the candidates' };
  if (!L.pool.some(p => p.id === inId)) return { error: 'That player is not in this draft' };
  if (L.candidates.some(p => p.id === inId)) return { error: 'That player is already a candidate' };
  let include = c.include.filter(id => id !== outId && playerById(t, id));
  let exclude = c.exclude.filter(id => id !== inId && playerById(t, id));
  if (c.include.indexOf(outId) < 0) exclude.push(outId);   // a rating pick is taken out; a hand pick just goes
  include.push(inId);
  return { include, exclude };
}

// What a viewer may see of the votes. With live votes off a ballot reaches nobody but its voter
// (organizers included): during a round only how many have voted, after it only the counts.
function viewFor(t, viewerPid) {
  if (!t.capVotes) return null;
  const out = {};
  for (const k of Object.keys(t.capVotes)) {
    const v = t.capVotes[k];
    const o = {
      division: v.division, state: v.state, cfg: Object.assign({}, v.cfg),
      voterIds: v.voterIds.slice(), candidateIds: v.candidateIds.slice(), seats: v.seats.slice(),
      startedAt: v.startedAt, endedAt: v.endedAt || null,
      results: v.results.map(x => {
        const c = { seat: x.seat, winner: x.winner, how: x.how, counts: Object.assign({}, x.counts), votes: x.votes, voters: x.voters, at: x.at };
        if (x.replaced) c.replaced = x.replaced;
        if (v.cfg.live && x.ballots) c.ballots = Object.assign({}, x.ballots);
        return c;
      }),
      round: null
    };
    const r = v.round;
    if (r) {
      o.round = {
        n: r.n, seat: r.seat, startedAt: r.startedAt, endsAt: r.endsAt, left: r.left != null ? r.left : null,
        voted: Object.keys(r.ballots).filter(id => v.voterIds.indexOf(id) >= 0).length,
        mine: (viewerPid && r.ballots[viewerPid]) || null
      };
      if (v.cfg.live) o.round.ballots = Object.assign({}, r.ballots);
    }
    out[k] = o;
  }
  return out;
}

module.exports = { minuteMs, vkey, voteCfgOf, cleanVoteCfg, voteLists, voteStartError, votePool, startVote, startDraftFrom,
  sweep, castVote, controlVote, cancelVote, replaceSeat, playerRemoved, swapCandidate, currentVote, viewFor, remaining };
