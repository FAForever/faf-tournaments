'use strict';
// A captains draft on one tab (decision 73) and captains chosen by a vote of the players
// (decision 74).
//
// The tab: "Players" during signups (everything the Players tab had, and for organizers the
// captain settings above the list), "Draft" while the captains are chosen and the picks are made,
// "Teams" after. With divisions (King, Prince...) it becomes one tab per division when the draft
// starts, each showing that division only: what is happening in it, its teams, then the list.
// The list switches between the player pool (the substitutes, after the draft) and every player,
// with every organizer button the Players tab had.

// ---------- small helpers ----------
function myPlayerIdT() { return (T.viewer && T.viewer.signedUpPlayerId) || null; }
function pName(id) { const p = T.players.find(x => x.id === id); return p ? p.name : '?'; }
function pRating(id) { const p = T.players.find(x => x.id === id); return p && p.rating != null ? p.rating : null; }
// The division drafting now (its captains being chosen, or its picks), or null outside a draft.
function draftingDivision() {
  if (!(T.status === 'draft' && T.draft)) return null;
  return T.draft.division || (divisionsOnT() ? 1 : 0);
}
function draftTabLabel(d) {
  if (T.status === 'signup') return 'Players';
  const dn = divisionsOnT() ? divisionNameOf(d || 1) + ' ' : '';
  const cur = draftingDivision();
  const drafting = cur != null && (!divisionsOnT() || (d || 1) >= cur);
  return dn ? dn + (drafting ? 'draft' : 'teams') : (drafting ? 'Draft' : 'Teams');
}

// ---------- the tab ----------
function drawDraftTab(el, d) {
  stopCapVoteClock();
  if (T.status === 'signup') {
    // the organizer's captain settings first, then everything the Players tab had
    el.innerHTML = '<div id="dtTop"></div><div id="dtList"></div>';
    if (viewerIsOrganizer()) drawTeams(document.getElementById('dtTop'), { merged: true, division: d });
    drawPlayers(document.getElementById('dtList'));
    wireVoteSettings(el);
    return;
  }
  drawTeams(el, { merged: true, division: d });
  wireDraftTab(el, d);
}

// What the tab shows once signups are closed: this division's state (the vote, the picks, the
// wait), its teams, the list, and the organizer's panels.
function draftTabBodyHTML(d, admin) {
  const divs = divisionsOnT();
  const cur = draftingDivision();
  const here = !divs || (d || 1) === cur;
  const v = capVoteFor(d);
  let html = '';
  if (cur != null && here) {
    if (v && v.state !== 'drafting') html += capVotePanelHTML(d, v, admin);
    else if (T.draft.waiting) html += waitingDivisionHTML(admin);
    else html += draftTurnHTML(admin) + draftPickOrderHTML();
  } else if (cur != null && divs && (d || 1) > cur) {
    html += upcomingDivisionHTML(d || 1, admin);
  }
  html += teamGridsHTML(divs ? (d || 1) : 0);
  html += draftListHTML(d, admin);
  // a vote that made its captains stays on record, under the teams and the list
  if (v && v.state === 'drafting') html += capVoteResultHTML(d, v, true);
  if (!divs || (d || 1) <= 1) html += divisionsPanelHTML(admin);
  html += readyPanelHTML(admin);
  return html;
}

// The list under the teams: the player pool while this division picks (the substitutes once the
// draft is over), or every player. Where there is no such list (a vote, a wait, another
// division's turn), just a button that shows every player.
function dtView() { try { return localStorage.getItem('faf_dtview') === 'all' ? 'all' : 'list'; } catch (e) { return 'list'; } }
function setDtView(v) { try { localStorage.setItem('faf_dtview', v); } catch (e) {} }
function draftListHTML(d, admin) {
  const divs = divisionsOnT();
  const cur = draftingDivision();
  const picking = cur != null && (!divs || (d || 1) === cur) && !T.draft.waiting && !T.draft.voting;
  const allN = T.players.filter(p => !p.pending || admin).length;
  const view = dtView();
  let first = null;
  if (picking) first = 'Player pool (' + T.players.filter(p => !p.teamId && !p.pending && !p.noShow).length + ')';
  else if (cur == null) first = 'Substitutes (' + (T.subs || []).length + ')';
  if (!first) {
    const on = view === 'all';
    return '<div class="dt-switch"><button type="button" class="dt-sw' + (on ? ' on' : '') + '" data-dtview="' + (on ? 'list' : 'all') + '">'
      + (on ? 'Hide all players' : 'Show all players (' + allN + ')') + '</button></div>' + (on ? '<div id="dtAll"></div>' : '');
  }
  const sw = '<div class="dt-switch"><button type="button" class="dt-sw' + (view === 'list' ? ' on' : '') + '" data-dtview="list">' + esc(first) + '</button>'
    + '<button type="button" class="dt-sw' + (view === 'all' ? ' on' : '') + '" data-dtview="all">All players (' + allN + ')</button></div>';
  if (view === 'all') return sw + '<div id="dtAll"></div>';
  if (picking) return sw + draftPoolPanelHTML(admin);
  return sw + (subsPanelHTML() || '<div class="panel section"><div class="empty">No substitutes: everyone is on a team.</div></div>');
}

// A division whose turn has not come yet: when it starts and how its captains are chosen. The
// organizer can still change that here.
function upcomingDivisionHTML(d, admin) {
  const c = (T.divCaptains || []).find(x => x.division === d) || { mode: 'rating', count: 0 };
  const prev = divisionNameOf(d - 1), nm = divisionNameOf(d);
  const how = c.mode === 'manual' ? 'the organizer chooses them'
    : c.mode === 'vote' ? (c.count >= 2 ? 'the players left vote for ' + c.count : 'the players left vote for them')
    : (c.count >= 2 ? 'the ' + c.count + ' highest rated of the players left, chosen automatically' : 'the organizer chooses them');
  const left = playersLeftAfterCurrent();
  let html = `<div class="draft-turn">The <strong>${esc(nm)}</strong> draft starts when the <strong>${esc(prev)}</strong> draft is done.
    Its captains: ${esc(how)}.${left != null ? ' About ' + left + ' player' + (left === 1 ? '' : 's') + ' will be left for it.' : ''}</div>`;
  if (admin) html += `<div class="panel section dt-upcoming">${laterDivisionsHTML(d)}</div>`;
  return html;
}
// How many players the division drafting now leaves for the next one.
function playersLeftAfterCurrent() {
  if (!(T.status === 'draft' && T.draft)) return null;
  const free = T.players.filter(p => !p.teamId && !p.pending && !p.noShow).length;
  const d = T.draft;
  if (d.waiting) return null;
  if (d.voting) {
    const v = capVoteNow();
    return v ? Math.max(0, free - v.cfg.count * T.teamSize) : null;
  }
  return Math.max(0, free - Math.max(0, d.order.length - d.current));
}

function wireDraftTab(el, d) {
  el.querySelectorAll('[data-dtview]').forEach(b => b.onclick = () => { setDtView(b.dataset.dtview); redrawInPlace(); });
  const all = document.getElementById('dtAll');
  if (all) drawPlayers(all);
  wireCapVote(el, d);
  wireVoteSettings(el);
}

// ---------- captain votes: state ----------
function capVoteFor(d) { return (T.capVotes && T.capVotes[String(d || 0)]) || null; }
function capVoteNow() {
  if (!(T.status === 'draft' && T.draft && T.draft.voting)) return null;
  return capVoteFor(T.draft.division || 0);
}
// The candidates the running round is between: not elected yet, still in the tournament.
function capVoteLeft(v) {
  return v.candidateIds.filter(id => v.seats.indexOf(id) < 0 && T.players.some(p => p.id === id && !p.teamId));
}
// For the banner at the top of the tournament: a voter who has not voted in this round yet.
function capVoteTurn() {
  const v = capVoteNow();
  const me = myPlayerIdT();
  if (!v || v.state !== 'open' || !v.round || !me || v.voterIds.indexOf(me) < 0 || v.round.mine) return null;
  return { text: 'Vote for captain ' + (v.round.seat + 1) + ' of ' + v.cfg.count + ' before the time runs out.',
    tab: draftTabKey(v.division), cta: 'Vote' };
}

// ---------- captain votes: the panel ----------
function capVoteHowText(r) {
  const n = (r.counts || {})[r.winner] || 0;
  const base = r.how === 'votes' ? n + ' of ' + r.votes + ' vote' + (r.votes === 1 ? '' : 's')
    : r.how === 'tie' ? 'tied on ' + n + ' vote' + (n === 1 ? '' : 's') + ', the higher rating wins'
    : r.how === 'none' ? 'nobody voted, so the highest rated candidate'
    : r.how === 'only' ? 'the only candidate left'
    : r.how === 'fill' ? 'no candidate left, so the highest rated player'
    : '';
  return base + (r.replaced ? '; replaced ' + pName(r.replaced) + ', by the organizer' : '');
}
function capVotePanelHTML(d, v, admin) {
  const divName = (d && divisionsOnT()) ? divisionNameOf(d) + ' ' : '';
  const me = myPlayerIdT();
  const amVoter = !!me && v.voterIds.indexOf(me) >= 0;
  let html = '<div class="panel section capvote" data-cvpanel="' + (d || 0) + '">';
  if (v.state === 'done') {
    html += `<h2>${esc(divName)}Captain vote <span class="h2-strong">is over</span></h2>
      <p class="muted small">The captains in seed order are below. ${admin ? 'Replace one who does not want to captain, then start the draft.' : 'The draft starts when the organizer starts it.'}</p>
      <ol class="cv-elected">${v.seats.map((id, i) => `<li><strong>${esc(pName(id))}</strong> <span class="muted small">${esc(capVoteHowText(v.results.filter(x => x.seat === i).pop() || {}))}</span>${admin ? ' <button class="btn ghost small" data-cvseat="' + i + '">Replace</button>' : ''}</li>`).join('')}</ol>
      ${admin ? '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn amber" id="cvStartDraft">Start the ' + esc(divName) + 'draft</button><button class="btn ghost" data-cvctl="cancel">Cancel the vote</button></div>' : ''}`;
    return html + '</div>' + capVoteResultHTML(d, v, false);
  }
  const r = v.round || { seat: v.seats.indexOf(null), ballots: {} };
  const paused = v.state === 'paused';
  const left = capVoteLeft(v);
  const msLeft = paused ? (r.left || 0) : (r.endsAt - srvNow());
  html += `<div class="cv-head"><h2>${esc(divName)}Captain vote <span class="h2-strong">captain ${r.seat + 1} of ${v.cfg.count}</span></h2>
      <span class="cv-clock${paused ? ' paused' : ''}" data-cvclock="${paused ? '' : r.endsAt}" data-cvround="${r.n || 0}">${paused ? 'Paused: ' + fmtClock(msLeft) + ' left' : fmtClock(msLeft)}</span></div>
    <p class="muted small">Who captains seed ${r.seat + 1}? Every voter has one vote and can change it until the time runs out; the most votes wins, and a tie goes to the higher rating. ${v.cfg.live ? 'Votes are shown live.' : 'Votes are secret: only the counts are shown, once this round is over.'}</p>`;
  const mine = r.mine || null;
  const status = amVoter
    ? (paused ? 'The vote is paused.' : mine ? 'You voted for <strong>' + esc(pName(mine)) + '</strong>. You can change it until the time runs out.' : 'You have not voted yet.')
    : (me ? 'You are not one of the voters (' + (v.cfg.voters > 0 ? 'the ' + v.cfg.voters + ' highest rated' + (d > 1 ? ' of the players left' : '') + ' vote'
        : d > 1 ? 'the players left vote' : 'everyone in the draft with a FAF account votes') + ').'
      : (fafAuth.enabled && !viewerLoggedIn() ? 'Log in with FAF to vote, if you are one of the voters.' : ''));
  if (status) html += '<p class="cv-me">' + status + '</p>';
  const ballots = r.ballots || null;   // live votes only
  const byCand = {};
  if (ballots) for (const voter of Object.keys(ballots)) (byCand[ballots[voter]] = byCand[ballots[voter]] || []).push(voter);
  const rows = left.slice().sort((a, b) => (pRating(b) || 0) - (pRating(a) || 0)).map(id => {
    const isMine = mine === id;
    const act = amVoter && !paused
      ? (isMine ? '<span class="cv-mine">\u2713 Your vote</span> <a href="#" class="muted small" data-cvvote="">take back</a>' : '<button class="btn amber small" data-cvvote="' + esc(id) + '">Vote</button>')
      : (isMine ? '<span class="cv-mine">\u2713 Your vote</span>' : '');
    const live = ballots ? '<td class="cv-live"><span class="cv-n">' + ((byCand[id] || []).length) + '</span> ' + (byCand[id] || []).map(x => '<span class="cv-voter">' + esc(pName(x)) + '</span>').join('') + '</td>' : '';
    return `<tr class="${isMine ? 'cv-row-mine' : ''}"><td>${esc(pName(id))}</td><td class="mono">${pRating(id) != null ? pRating(id) : '-'}</td>${live}<td style="text-align:right;white-space:nowrap">${act}</td></tr>`;
  }).join('');
  html += `<table class="cv-cands"><thead><tr><th>Candidate</th><th style="width:80px">Rating</th>${ballots ? '<th>Votes</th>' : ''}<th style="width:150px"></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small" style="margin-top:8px">${r.voted || 0} of ${v.voterIds.length} voter${v.voterIds.length === 1 ? ' has' : 's have'} voted.</p>`;
  if (admin) {
    html += `<div class="cv-ctl">
      ${paused ? '<button class="btn small" data-cvctl="resume">Resume</button>' : '<button class="btn small" data-cvctl="pause">Pause</button>'}
      <button class="btn ghost small" data-cvctl="add" data-min="1">+1 min</button>
      <button class="btn ghost small" data-cvctl="add" data-min="5">+5 min</button>
      <button class="btn ghost small" data-cvctl="end">End this round now</button>
      <button class="btn danger small" data-cvctl="cancel">Cancel the vote</button>
      ${d > 1 && (T.draftDone || []).some(x => x.picks > 0) ? '<button class="btn ghost small" id="cvUndoPrev">\u21b6 Undo the last ' + esc(divisionNameOf(d - 1)) + ' pick</button>' : ''}</div>`;
  }
  return html + '</div>' + capVoteResultHTML(d, v, false);
}
// The captains elected so far (all of them once it is over), and every round's counts.
function capVoteResultHTML(d, v, finished) {
  if (!v.results.length) return '';
  const divName = (d && divisionsOnT()) ? divisionNameOf(d) + ' ' : '';
  const seats = v.seats.map((id, i) => id ? '<li><strong>' + esc(pName(id)) + '</strong> <span class="muted small">' + esc(capVoteHowText(v.results.filter(x => x.seat === i).pop() || {})) + '</span></li>' : '').join('');
  const rounds = v.results.map(r => {
    const counts = Object.keys(r.counts || {}).sort((a, b) => (r.counts[b] - r.counts[a]) || ((pRating(b) || 0) - (pRating(a) || 0)));
    const line = counts.length ? counts.map(id => esc(pName(id)) + ' ' + r.counts[id]).join(', ') : esc(capVoteHowText(r));
    const who = r.ballots ? '<div class="muted small">' + Object.keys(r.ballots).map(x => esc(pName(x)) + ' \u2192 ' + esc(pName(r.ballots[x]))).join(', ') + '</div>' : '';
    return '<li>Captain ' + (r.seat + 1) + ': ' + line + (r.votes != null && counts.length ? ' <span class="muted small">(' + r.votes + ' of ' + r.voters + ' voted)</span>' : '') + who + '</li>';
  }).join('');
  return `<div class="panel section"><h2>${esc(divName)}${finished ? 'Captains <span class="h2-strong">by vote</span>' : 'Captains <span class="h2-strong">so far</span>'}</h2>
    <ol class="cv-elected">${seats}</ol>
    <details class="cv-rounds"><summary class="muted small">Votes per round</summary><ol>${rounds}</ol></details></div>`;
}

// ---------- captain votes: wiring and the clock ----------
let _cvClock = null, _cvAsked = {};
function stopCapVoteClock() { if (_cvClock) { clearInterval(_cvClock); _cvClock = null; } }
function wireCapVote(el, d) {
  el.querySelectorAll('[data-cvvote]').forEach(b => b.onclick = async e => {
    e.preventDefault();
    const v = capVoteNow();
    if (!v || !v.round) return;
    try {
      await api('/api/t/' + T.id + '/cap_vote', { candidateId: b.dataset.cvvote || '', round: v.round.n });
      toast(b.dataset.cvvote ? 'Vote saved: ' + pName(b.dataset.cvvote) : 'Vote taken back');
      await refresh();
    } catch (err) { toast(err.message, true); await refresh(); }
  });
  el.querySelectorAll('[data-cvctl]').forEach(b => b.onclick = async () => {
    const op = b.dataset.cvctl;
    if (op === 'cancel' && !confirm('Cancel the captain vote? Every round so far is discarded. ' + (draftingDivision() > 1 ? "The organizer then chooses how this division's captains are picked." : 'Signups open again, with the settings kept.'))) return;
    if (op === 'end' && !confirm('End this round now? The votes so far decide it.')) return;
    try {
      const cur = capVoteNow();
      await api('/api/t/' + T.id + '/phase', { action: 'vote_ctl', op, minutes: b.dataset.min ? parseInt(b.dataset.min, 10) : undefined,
        round: op !== 'cancel' && cur && cur.round ? cur.round.n : undefined, admin: adminToken() });
      await refresh();
    } catch (err) { toast(err.message, true); }
  });
  el.querySelectorAll('[data-cvseat]').forEach(b => b.onclick = () => {
    const v = capVoteNow();
    if (!v) return;
    const seat = parseInt(b.dataset.cvseat, 10);
    const pool = T.players.filter(p => !p.teamId && !p.pending && !p.noShow && v.seats.indexOf(p.id) < 0)
      .sort((a, b2) => (b2.rating || 0) - (a.rating || 0));
    pickPlayerModal('Captain ' + (seat + 1) + ' instead of ' + pName(v.seats[seat]), "They take this captain's place and seed.", pool, async id => {
      await api('/api/t/' + T.id + '/phase', { action: 'vote_seat', seat, in: id, admin: adminToken() });
      toast(pName(id) + ' is captain ' + (seat + 1));
    });
  });
  // a later division's vote: taking back the division above's last pick stops it (the server
  // removes this division's vote with it) and reopens that draft
  const up = document.getElementById('cvUndoPrev');
  if (up) up.onclick = async () => {
    if (!confirm('Undo the last ' + divisionNameOf(d - 1) + ' pick? This stops the ' + divisionNameOf(d) + ' captain vote and reopens the ' + divisionNameOf(d - 1) + ' draft.')) return;
    // the reopened draft is the one above: go there
    try { await api('/api/t/' + T.id + '/undo_pick', { token: myToken() }); toast('Pick undone'); currentTab = draftTabKey(d - 1); syncTabURL(); await refresh(); }
    catch (err) { toast(err.message, true); }
  };
  const sd = document.getElementById('cvStartDraft');
  if (sd) sd.onclick = async () => {
    try { await api('/api/t/' + T.id + '/phase', { action: 'start_draft', admin: adminToken() }); await refresh(); }
    catch (err) { toast(err.message, true); }
  };
  // the countdown, on the server's clock; at zero, fetch the result
  const tick = () => {
    const clocks = document.querySelectorAll('[data-cvclock]');
    if (!clocks.length) { stopCapVoteClock(); return; }
    clocks.forEach(c => {
      if (!c.dataset.cvclock) return;
      const ms = parseInt(c.dataset.cvclock, 10) - srvNow();
      c.textContent = fmtClock(ms);
      c.classList.toggle('low', ms < 30000);
      const key = c.dataset.cvround;
      if (ms <= 0 && !_cvAsked[key]) { _cvAsked[key] = 1; setTimeout(() => { refresh().catch(() => {}); }, 600); }
    });
  };
  if (el.querySelector('[data-cvclock]')) { tick(); _cvClock = setInterval(tick, 500); }
}
// A modal to choose one player from a list (Replace).
function pickPlayerModal(title, note, pool, onPick) {
  if (!pool.length) { toast('Nobody else is left to choose from', true); return; }
  modal(`<h3>${esc(title)}</h3><p class="muted small">${esc(note)}</p>
    <select id="ppSel" style="width:100%">${pool.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.rating != null ? ' (' + p.rating + ')' : '') + '</option>').join('')}</select>
    <div class="actions"><button class="btn ghost" id="ppCancel">Cancel</button><button class="btn primary" id="ppGo">Choose</button></div>`, root => {
    root.querySelector('#ppCancel').onclick = closeModal;
    root.querySelector('#ppGo').onclick = async () => {
      try { await onPick(root.querySelector('#ppSel').value); closeModal(); await refresh(); }
      catch (err) { toast(err.message, true); }
    };
  });
}

// ---------- captain votes: the settings ----------
// The vote's own settings for division 1 (or none) and a waiting division: who votes, who can be
// voted for, the time per captain, live or secret, and whether the draft starts by itself.
function voteFieldsHTML(cfg) {
  const c = cfg || {};
  return `<div id="capVoteWrap">
    <div class="cv-fields" style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-top:12px">
      <div><div class="muted small">Who votes: the top</div><input type="number" id="cvVoters" min="1" max="999" value="${c.voters > 0 ? c.voters : ''}" placeholder="everyone" style="width:110px"> <span class="muted small">by rating</span></div>
      <div><div class="muted small">Who can be voted for: the top</div><input type="number" id="cvCands" min="2" max="999" value="${c.candidates || ''}" placeholder="e.g. 8" style="width:110px"> <span class="muted small">by rating</span></div>
      <div><div class="muted small">Minutes per captain</div><input type="number" id="cvMinutes" min="1" max="60" value="${c.minutes || 5}" style="width:90px"></div>
    </div>
    <label class="prop-cb" style="margin-top:10px"><input type="checkbox" id="cvLive"${c.live ? ' checked' : ''}> Show votes live: everyone sees who votes for whom while a round runs (off: only the counts, after each round)</label>
    <label class="prop-cb"><input type="checkbox" id="cvAutoDraft"${c.autoDraft === 0 ? '' : ' checked'}> Start the draft as soon as the vote is over (off: you start it, and can replace a captain first)</label>
    <p class="muted small" style="margin-top:6px">One round per captain, in seed order: the first round elects the seed 1 captain, and so on. Every voter has one vote per round, can vote for themselves and can change it until the time runs out; the most votes wins, a tie goes to the higher rating. Voting needs a FAF account.</p>
    <div id="cvPreview" class="cap-count"></div>
  </div>`;
}
function readVoteFields() {
  const g = id => document.getElementById(id);
  if (!g('cvCands')) return null;
  const n = id => { const x = parseInt(g(id).value, 10); return isFinite(x) ? x : null; };
  const o = { voters: n('cvVoters') || 0, minutes: n('cvMinutes') || 5, live: g('cvLive').checked ? 1 : 0, autoDraft: g('cvAutoDraft').checked ? 1 : 0 };
  if (n('cvCands') != null) o.candidates = n('cvCands');
  return o;
}
// Who would vote and be voted for if the vote started now (the server works it out the same way at
// the start, and refuses with the reason if something is off).
function cvPoolNow(d) {
  if (d > 1) return T.players.filter(p => !p.teamId && !p.pending && !p.noShow);
  const ci = (typeof playerCheckinOn === 'function' && playerCheckinOn()) ? checkinSplit() : null;
  const out = {};
  if (ci && ci.applies) for (const p of ci.out) out[p.id] = 1;
  return T.players.filter(p => !p.pending && !p.noShow && !out[p.id] && !p.teamId);
}
function cvByRating(list) {
  const idx = {};
  T.players.forEach((p, i) => { idx[p.id] = i; });
  return list.slice().sort((a, b) => ((b.rating || 0) - (a.rating || 0)) || (idx[a.id] - idx[b.id]));
}
function cvListsNow(d, count, f) {
  const pv = (T.votePreview || {})[String(d || 0)] || { include: [], exclude: [] };
  const pool = cvByRating(cvPoolNow(d));
  const canVote = pool.filter(p => p.fafId);
  const voters = f.voters > 0 ? canVote.slice(0, f.voters) : canVote;
  const C = f.candidates || (count >= 2 ? count * 2 : 0);
  const ex = {};
  (pv.exclude || []).forEach(id => { ex[id] = 1; });
  const added = (pv.include || []).map(id => pool.find(p => p.id === id)).filter(Boolean);
  const rest = pool.filter(p => !ex[p.id] && added.indexOf(p) < 0);
  const cands = cvByRating(added.concat(rest.slice(0, Math.max(0, C - added.length))));
  return { pool, voters, cands, C, noFaf: pool.length - canVote.length, hand: added.length + (pv.exclude || []).length, pv };
}
function paintVotePreview(d, count) {
  const box = document.getElementById('cvPreview');
  const f = readVoteFields();
  if (!box || !f) return;
  const L = cvListsNow(d, count, f);
  let err = '';
  if (!(count >= 2)) err = 'Enter how many captains (2 or more).';
  else if (L.C <= count) err = 'The players who can be voted for must be more than the captains (' + (count + 1) + ' or more).';
  else if (L.cands.length <= count) err = 'Only ' + L.cands.length + ' player' + (L.cands.length === 1 ? '' : 's') + ' can be voted for so far; ' + (count + 1) + ' are needed.';
  else if (!L.voters.length) err = 'Nobody can vote yet: voting needs a FAF account.';
  const problems = (L.pv.problems || []).map(x => '<div class="warn">' + esc(x) + '</div>').join('');
  const html = (err ? '<div class="warn">' + esc(err) + '</div>' : '') + problems
    + '<div style="margin-top:6px"><strong>' + L.voters.length + '</strong> would vote: <span class="muted small">' + L.voters.map(p => esc(p.name)).join(', ') + '</span>'
    + (L.noFaf ? ' <span class="muted small">(' + L.noFaf + ' without a FAF account cannot vote)</span>' : '') + '</div>'
    + '<div style="margin-top:8px"><strong>' + L.cands.length + '</strong> could be voted for:' + (L.hand ? ' <a href="#" class="small" data-cvreset="1">back to the top by rating</a>' : '') + '</div>'
    + '<table class="cv-preview"><tbody>' + L.cands.map(p => '<tr><td>' + esc(p.name) + ((L.pv.include || []).indexOf(p.id) >= 0 ? ' <span class="idbadge late">by hand</span>' : '') + '</td><td class="mono">' + (p.rating != null ? p.rating : '-')
      + '</td><td style="text-align:right"><button class="btn ghost small" data-cvswap="' + esc(p.id) + '">Replace</button></td></tr>').join('') + '</tbody></table>';
  // unchanged: leave it alone. Leaving a field fires "change" on the mousedown of the next click;
  // redrawing then would swap the button under the pointer and lose that click.
  if (box._cvHtml === html) return;
  box._cvHtml = html;
  box.innerHTML = html;
  box.querySelectorAll('[data-cvswap]').forEach(b => b.onclick = () => {
    const out = b.dataset.cvswap;
    const inC = {};
    L.cands.forEach(p => { inC[p.id] = 1; });
    pickPlayerModal('Instead of ' + pName(out), 'Chosen by hand: they can be voted for in ' + pName(out) + "'s place.", L.pool.filter(p => !inC[p.id]), async id => {
      await api('/api/t/' + T.id + '/phase', { action: 'vote_swap', division: d || undefined, out, in: id, admin: adminToken() });
      toast(pName(id) + ' can be voted for instead of ' + pName(out));
    });
  });
  const rs = box.querySelector('[data-cvreset]');
  if (rs) rs.onclick = async e => {
    e.preventDefault();
    try { await api('/api/t/' + T.id + '/phase', { action: 'vote_swap', division: d || undefined, reset: 1, admin: adminToken() }); await refresh(); }
    catch (err) { toast(err.message, true); }
  };
}
// The vote settings' preview follows the inputs (the saving is done by the captain controls).
function wireVoteSettings(el) {
  const wrap = document.getElementById('capVoteWrap');
  if (!wrap) return;
  const waitingDiv = (T.status === 'draft' && T.draft && T.draft.waiting) ? T.draft.division : 0;
  const d = waitingDiv || (divisionsOnT() ? 1 : 0);
  const count = () => parseInt((document.getElementById('capNum') || {}).value, 10) || 0;
  const paint = () => paintVotePreview(d, count());
  wrap.querySelectorAll('input').forEach(i => { i.addEventListener('input', paint); i.addEventListener('change', paint); });
  const num = document.getElementById('capNum');
  if (num) num.addEventListener('input', paint);
  paint();
}
