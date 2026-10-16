// Tournament proposals (decision 59).
//
// Anyone with a FAF account can build a tournament and PROPOSE it to the TD team instead of
// running it. A tournament director takes it over ("I will TD this") and runs it, or declines it
// and says what is missing; when nobody does within the timeout it comes back to the proposer as
// well, who can fix it and propose it again. Publishing a taken-over proposal still needs a second
// director (decision 51): the one who took it over cannot approve it. The server holds every rule
// (the proposal_* endpoints, the freeze while it waits, the proposer's locks); this file draws the
// proposal box above the tabs, its dialogs, the home page chips and the console's Proposals tab.

function proposalsOn() { return !!(fafAuth && fafAuth.proposals); }
function proposalDaysSetting() { return (fafAuth && fafAuth.proposalDays) || 28; }

function propDaysLeft(until) { return Math.max(0, Math.ceil((Number(until) - Date.now()) / 86400000)); }
function propLeftText(until) {
  const d = propDaysLeft(until);
  return d === 0 ? 'less than a day left' : d === 1 ? '1 day left' : d + ' days left';
}
// What the proposer asked of the director who takes it over, in words. `you`: the proposer reads it.
function propAnswersHTML(P, you) {
  const yes = '<span class="prop-yes">may change</span>', no = '<span class="prop-no">must keep as proposed</span>';
  const keep = you
    ? (P.keep ? 'You stay a co-organizer' : 'You hand it over (you stop being an organizer, but keep seeing it)')
    : '<strong>' + esc(P.byName || P.by || 'The proposer') + '</strong>' + (P.keep ? ' stays a co-organizer' : ' hands it over (no longer an organizer, but keeps seeing it)');
  return '<ul class="prop-answers">' +
    '<li>The maps, map pools and vetoes: the director ' + (P.lockMaps ? no : yes) + '</li>' +
    '<li>The format and bracket: the director ' + (P.lockFormat ? no : yes) + '</li>' +
    '<li>' + keep + '</li>' +
    '</ul>';
}
// The latest time it came back to its proposer, in one line.
function propLastHTML(P) {
  const L = P.last;
  if (!L) return '';
  if (L.act === 'declined') return '<div class="pub-state pub-no">&#10007; Declined by <strong>' + esc(L.byName) + '</strong> on ' + esc(fmtDateTime(L.at)) + ': <em>' + esc(L.reason) + '</em>. Fix it and propose it again.</div>';
  if (L.act === 'timeout') return '<div class="pub-state pub-warn">&#9201; Came back on ' + esc(fmtDateTime(L.at)) + ': ' + esc(L.reason) + '. Propose it again whenever you like.</div>';
  if (L.act === 'released') return '<div class="pub-state pub-warn">&#8617; <strong>' + esc(L.byName) + '</strong> gave it back on ' + esc(fmtDateTime(L.at)) + ': <em>' + esc(L.reason) + '</em></div>';
  if (L.act === 'withdrawn') return '<div class="pub-state">You withdrew it on ' + esc(fmtDateTime(L.at)) + '.</div>';
  return '';
}

// Everything about the proposal above the tabs: the proposer's and organizers' box, and the
// director's box (take it over or decline it).
function proposalBannerHTML(admin) {
  const P = T && T.proposal;
  if (!P || !P.state) return '';
  // the proposer's side: the proposer and its named organizers (a site admin's or a director's
  // blanket rights do not make it theirs); once taken over, everyone running it
  const mine = !!P.mine, org = !!P.organizer, runs = org || !!admin;
  let out = '';
  if (P.state === 'draft' && (mine || org)) {
    out += `<div class="panel prop-box" style="margin-top:12px">
      <div class="mono small prop-head">PROPOSAL</div>
      <p style="margin:6px 0">You build it, a tournament director runs it. When it is ready, propose it to the TD team: a director takes it over and runs it, or tells you what is missing. Set it up the way you want it played: the format, rating limits, the maps (Maps tab), mods and rewards. The date can stay open: the TD team picks one with you.</p>
      ${propLastHTML(P)}
      <div class="pub-actions">
        ${P.canSubmit ? '<button class="btn primary" id="propSubmit">Propose to the TD team</button>' : ''}
        ${P.canDrop ? '<button class="btn ghost" id="propDrop">Host it myself instead</button>' : ''}
      </div>
    </div>`;
  } else if (P.state === 'proposed' && (mine || org)) {
    out += `<div class="panel prop-box prop-wait" style="margin-top:12px">
      <div class="mono small prop-head">PROPOSAL &middot; WAITING FOR THE TD TEAM</div>
      <p style="margin:6px 0">Proposed on ${esc(fmtDateTime(P.proposedAt))}. If no tournament director takes it over by <strong>${esc(fmtDateTime(P.until))}</strong> (${esc(propLeftText(P.until))}), it comes back to you. While it waits, nothing in it can change.</p>
      ${propAnswersHTML(P, mine)}
      ${P.note ? '<p class="muted small" style="margin:4px 0 0">Your note to the TD team: <em>' + esc(P.note) + '</em></p>' : ''}
      <div class="pub-actions">${P.canWithdraw ? '<button class="btn ghost" id="propWithdraw">Withdraw it to change something</button>' : ''}</div>
    </div>`;
  } else if (P.state === 'taken' && (mine || runs)) {
    const lockLines = [];
    if (P.lockMaps) lockLines.push(mine
      ? 'You asked that the <strong>maps, map pools and vetoes</strong> stay as you set them.' + (P.canUnlock ? ' <button class="btn ghost small" data-propunlock="maps">Let the director change them</button>' : '')
      : '<strong>' + esc(P.byName) + '</strong> asked that the <strong>maps, map pools and vetoes</strong> stay as proposed: changing them is refused until they lift that.' + (P.canUnlock ? ' <button class="btn ghost small" data-propunlock="maps">Lift it (site admin)</button>' : ''));
    if (P.lockFormat) lockLines.push(mine
      ? 'You asked that the <strong>format and bracket</strong> stay as you set them.' + (P.canUnlock ? ' <button class="btn ghost small" data-propunlock="format">Let the director change it</button>' : '')
      : '<strong>' + esc(P.byName) + '</strong> asked that the <strong>format and bracket</strong> stay as proposed: changing them is refused until they lift that.' + (P.canUnlock ? ' <button class="btn ghost small" data-propunlock="format">Lift it (site admin)</button>' : ''));
    out += `<div class="panel prop-box prop-taken" style="margin-top:12px">
      <div class="mono small prop-head">PROPOSAL &middot; TAKEN OVER</div>
      <p style="margin:6px 0">${mine ? 'Your proposal' : 'Proposed by <strong>' + esc(P.byName) + '</strong>. It'} was taken over by <strong>${esc(P.takenByName || '')}</strong> on ${esc(fmtDateTime(P.takenAt))}${P.takeNote ? ': <em>' + esc(P.takeNote) + '</em>' : '.'}
        ${mine ? ' They run it now.' : ''} Publishing it needs a second tournament director, not the one who took it over.</p>
      ${lockLines.map(l => '<p class="small prop-lock" style="margin:4px 0">' + l + '</p>').join('')}
      ${P.canRelease ? '<div class="pub-actions"><button class="btn ghost" id="propReleaseOpen">Give it back to ' + esc(P.byName) + '&hellip;</button></div>' +
        '<div id="propReleaseBox" class="pub-reject" hidden><textarea id="propReleaseWhy" rows="2" maxlength="300" placeholder="Why - ' + esc(P.byName) + ' sees this"></textarea><button class="btn danger small" id="propReleaseGo">Give it back</button></div>' : ''}
    </div>`;
  }
  // a director deciding on it
  if (P.state === 'proposed' && P.canDecide) {
    out += `<div class="panel prop-box prop-td" style="margin-top:12px">
      <div class="mono small prop-head">PROPOSAL FOR THE TD TEAM</div>
      <p style="margin:6px 0"><strong>${esc(P.byName)}</strong> proposed this on ${esc(fmtDateTime(P.proposedAt))}. It goes back to them on ${esc(fmtDateTime(P.until))} (${esc(propLeftText(P.until))}) if no director takes it over.</p>
      ${P.note ? '<p style="margin:4px 0 8px">Their note: <em>' + esc(P.note) + '</em></p>' : ''}
      ${propAnswersHTML(P, false)}
      <p class="muted small" style="margin:6px 0 10px">Read it first: the Overview (rules, rewards), the Maps tab and the format. Take it over and you become its organizer; decline it and say what is missing, and it goes back to them to fix.</p>
      <div class="pub-actions"><button class="btn primary" id="propTakeOpen">Take it over&hellip;</button><button class="btn danger" id="propDeclineOpen">Decline&hellip;</button></div>
      <div id="propDeclineBox" class="pub-reject" hidden>
        <textarea id="propDeclineWhy" rows="2" maxlength="300" placeholder="What is missing or has to change - ${esc(P.byName)} sees this"></textarea>
        <button class="btn danger small" id="propDeclineGo">Decline</button>
      </div>
    </div>`;
  }
  return out;
}

// The credit, once it is public.
function proposalCreditHTML() {
  const P = T && T.proposal;
  if (!P || !P.credit || T.published === 0 || (P.state && P.state !== 'taken')) return '';
  return '<div class="prop-credit muted small">Proposed by <strong>' + esc(P.credit) + '</strong> and run by the TD team</div>';
}

function wireProposalBanner() {
  const $ = id => document.getElementById(id);
  if ($('propSubmit')) $('propSubmit').onclick = () => openProposeDialog();
  if ($('propDrop')) $('propDrop').onclick = async () => {
    if (!confirm('Make this your own draft again? You then host it yourself: request publishing on its page.')) return;
    try { await api('/api/t/' + T.id + '/proposal_drop', {}); toast('It is your own draft again'); await refresh(); }
    catch (e) { toast(e.message, true); }
  };
  if ($('propWithdraw')) $('propWithdraw').onclick = async () => {
    if (!confirm('Withdraw it from the TD team? You can change it and propose it again; its waiting time starts over then.')) return;
    try { await api('/api/t/' + T.id + '/proposal_withdraw', {}); toast('Withdrawn - change what you need, then propose it again'); await refresh(); }
    catch (e) { toast(e.message, true); }
  };
  if ($('propTakeOpen')) $('propTakeOpen').onclick = () => openTakeDialog({ id: T.id, name: T.name, by: T.proposal.byName, keep: T.proposal.keep, lockMaps: T.proposal.lockMaps, lockFormat: T.proposal.lockFormat });
  if ($('propDeclineOpen')) $('propDeclineOpen').onclick = () => { $('propDeclineBox').hidden = false; $('propDeclineWhy').focus(); };
  if ($('propDeclineGo')) $('propDeclineGo').onclick = async () => {
    const why = $('propDeclineWhy').value.trim();
    if (!why) return toast('Say what is missing or has to change', true);
    try { await api('/api/t/' + T.id + '/proposal_decline', { reason: why }); toast('Declined - it went back to ' + T.proposal.byName + ' with your reason'); await refresh(); }
    catch (e) { toast(e.message, true); }
  };
  if ($('propReleaseOpen')) $('propReleaseOpen').onclick = () => { $('propReleaseBox').hidden = false; $('propReleaseWhy').focus(); };
  if ($('propReleaseGo')) $('propReleaseGo').onclick = async () => {
    const why = $('propReleaseWhy').value.trim();
    if (!why) return toast('Say why, so ' + T.proposal.byName + ' knows', true);
    if (!confirm('Give it back to ' + T.proposal.byName + '? It becomes their draft again, with the organizers it had; you are no longer its organizer.')) return;
    try { await api('/api/t/' + T.id + '/proposal_release', { reason: why }); toast('Given back'); await refresh(); }
    catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('[data-propunlock]').forEach(b => b.onclick = async () => {
    const which = b.dataset.propunlock;
    const what = which === 'maps' ? 'the maps, map pools and vetoes' : 'the format and bracket';
    let reason = '';
    if (!T.proposal.mine) {
      reason = prompt('Why lift it? ' + T.proposal.byName + ' asked that ' + what + ' stay as proposed. (They see this in the log.)') || '';
      if (!reason.trim()) return;
    } else if (!confirm('Let the director change ' + what + '?')) return;
    try { await api('/api/t/' + T.id + '/proposal_unlock', { which, reason }); toast('Lifted'); await refresh(); }
    catch (e) { toast(e.message, true); }
  });
}

// The proposer's questions, then off to the TD team.
function openProposeDialog() {
  const P = (T && T.proposal) || {};
  const days = (P.days || proposalDaysSetting());
  modal(`<h3>Propose to the <span class="h2-strong">TD team</span></h3>
    <p class="muted small">A tournament director reads it, then takes it over and runs it, or tells you what is missing. If nobody does within ${esc(days)} days, it comes back to you.</p>
    <label>The director who takes it over may change</label>
    <label class="prop-cb"><input type="checkbox" id="ppMaps"${P.lockMaps ? '' : ' checked'}> The maps, map pools and vetoes</label>
    <label class="prop-cb"><input type="checkbox" id="ppFormat"${P.lockFormat ? '' : ' checked'}> The format and bracket (bracket type, team size, match lengths, divisions, 3rd place, the playoff and early-end settings)</label>
    <p class="muted small" style="margin:4px 0 0">Untick what has to stay exactly as you set it. Running the event (seeding, results, check-in) is always the director's.</p>
    <label>After a director takes it over</label>
    <label class="prop-cb"><input type="radio" name="ppKeep" value="0"${P.keep ? '' : ' checked'}> Hand it over: I don't want to run it (you stop being an organizer, but keep seeing it)</label>
    <label class="prop-cb"><input type="radio" name="ppKeep" value="1"${P.keep ? ' checked' : ''}> Keep me as a co-organizer</label>
    <label>Anything the TD team should know? <span class="muted small">(optional)</span></label>
    <textarea id="ppNote" rows="3" maxlength="1000" placeholder="e.g. Any Saturday in November works for me; I can cast it">${esc(P.note || '')}</textarea>
    <p class="muted small" style="margin:8px 0 0">While it waits, nothing in it can change: withdraw it to change something.</p>
    <div class="actions"><button class="btn ghost" id="ppCancel">Cancel</button><button class="btn primary" id="ppGo">Propose</button></div>`, root => {
    root.querySelector('#ppCancel').onclick = closeModal;
    root.querySelector('#ppGo').onclick = async () => {
      const keepEl = root.querySelector('input[name="ppKeep"]:checked');
      try {
        const r = await api('/api/t/' + T.id + '/proposal_submit', {
          lockMaps: root.querySelector('#ppMaps').checked ? 0 : 1,
          lockFormat: root.querySelector('#ppFormat').checked ? 0 : 1,
          keep: keepEl && keepEl.value === '1' ? 1 : 0,
          note: root.querySelector('#ppNote').value.trim()
        });
        closeModal();
        toast('Proposed - the TD team has until ' + fmtDateTime(r.until) + ' to take it over');
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// "I will TD this": from the proposal's page or the console. `p` = { id, name, by, keep, lockMaps, lockFormat }.
function openTakeDialog(p, after) {
  const locks = [];
  if (p.lockMaps) locks.push('the maps, map pools and vetoes');
  if (p.lockFormat) locks.push('the format and bracket');
  modal(`<h3>Take over <span class="h2-strong">${esc(p.name)}</span>?</h3>
    <p>You become its organizer and run it. <strong>${esc(p.by)}</strong> ${p.keep ? 'stays a co-organizer.' : 'hands it over: they are no longer an organizer, but keep seeing it, and get it back if you give it back.'}</p>
    ${locks.length ? '<p class="warn small">' + esc(p.by) + ' asked that ' + esc(locks.join(' and ')) + ' stay as proposed: changing that is refused unless they lift it.</p>' : '<p class="muted small">You may change anything.</p>'}
    <label>Run it as</label>
    <label class="prop-cb"><input type="radio" name="tkCat" value="official" checked> Official (every tournament director can help run it)</label>
    <label class="prop-cb"><input type="radio" name="tkCat" value="community"> Community</label>
    <label>A note to ${esc(p.by)} <span class="muted small">(optional)</span></label>
    <input type="text" id="tkNote" maxlength="300" placeholder="e.g. We'll run it on 7 Nov at 18:00 UTC - OK for you?" autocomplete="off">
    <p class="muted small" style="margin:8px 0 0">Publishing still needs a second tournament director: when it is ready, request publishing on its page, and another director approves it.</p>
    <div class="actions"><button class="btn ghost" id="tkCancel">Cancel</button><button class="btn primary" id="tkGo">Take it over</button></div>`, root => {
    root.querySelector('#tkCancel').onclick = closeModal;
    root.querySelector('#tkGo').onclick = async () => {
      const cat = root.querySelector('input[name="tkCat"]:checked');
      try {
        await api('/api/t/' + p.id + '/proposal_take', { category: cat ? cat.value : 'official', note: root.querySelector('#tkNote').value.trim() });
        closeModal();
        toast('It is yours to run now');
        if (after) await after();
        else await refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// The chip a proposal's card carries on the home page.
function propChipHTML(t) {
  const p = t && t.prop;
  if (!p || !proposalsOn()) return '';
  if (p.s === 'proposed') return '<span class="idbadge pubchip pub-wait" title="Proposed to the TD team by ' + esc(p.by || '') + '">proposal &middot; ' + esc(propLeftText(p.until)) + '</span>';
  if (p.s === 'taken') return '<span class="idbadge pubchip pub-ok" title="Proposed by ' + esc(p.by || '') + '">taken over by ' + esc(p.taken || '') + '</span>';
  const act = p.last && p.last.act;
  if (act === 'declined') return '<span class="idbadge pubchip pub-no">proposal declined</span>';
  if (act === 'timeout') return '<span class="idbadge pubchip pub-warn">proposal came back</span>';
  if (act === 'released') return '<span class="idbadge pubchip pub-warn">proposal given back</span>';
  return '<span class="idbadge pubchip">proposal</span>';
}

// ---------- console: Proposals ----------
// What a director reads before deciding: the format, the date, signups, rating, maps, rewards,
// mods, the description, and what the proposer asked.
function proposalCardHTML(q) {
  const tt = Object.assign({ matches: [], teams: [], players: [], cfg: null, stage2: null, imported: false }, q);
  let fmt = '';
  try { fmt = esc(typeLine(tt)) + (planSummary(tt) ? '<br>' + esc(planSummary(tt)) : ''); } catch (e) { fmt = esc((q.teamSize || 1) + 'v' + (q.teamSize || 1) + ' ' + (q.bracketType || '')); }
  const when = q.eventDate ? esc(fmtDateTime(q.eventDate)) + (q.eventDays && q.eventDays.length > 1 ? ' <span class="muted small">(' + q.eventDays.length + ' days)</span>' : '')
    : '<span class="muted">No date - the TD team picks one</span>';
  const signups = [({ open: 'Open signups', request: 'Signups by request', invite: 'Invite only' })[q.signupMode] || 'Open signups'];
  if (q.maxTeams) signups.push('max ' + q.maxTeams);
  if (q.minTeams) signups.push('min ' + q.minTeams);
  if (q.checkInDeadline) signups.push('check-in');
  if (!q.playerReporting) signups.push('organizers report the scores');
  const rating = [q.ratingType === 'none' ? 'No rating' : (typeof ratingTypeLabel === 'function' ? ratingTypeLabel(q.ratingType) : q.ratingType) + ' rating'];
  if (q.minRating != null || q.maxRating != null) rating.push((q.minRating != null ? q.minRating : '0') + '-' + (q.maxRating != null ? q.maxRating : 'any'));
  if (q.maxTeamRating != null) rating.push('team max ' + q.maxTeamRating);
  if (q.ratingCap != null) rating.push('capped at ' + q.ratingCap);
  const pools = (q.pools || []).map(pl => '<div><strong>' + esc(pl.name) + '</strong> <span class="muted small">Bo' + esc(pl.bo) + (pl.published ? '' : ', not published') + '</span>: ' +
    (pl.maps.length ? pl.maps.map(esc).join(', ') : '<span class="muted">no maps</span>') + '</div>').join('');
  const maps = (q.maps ? q.maps + ' map' + (q.maps === 1 ? '' : 's') : 'No maps yet') +
    (q.veto ? ' &middot; map vetoes (' + esc(q.veto.mode === 'continuous' ? 'continuous' : 'all upfront') + ')' : ' &middot; no map veto') +
    (q.fveto ? ' &middot; faction vetoes (' + esc(q.fveto.bans) + ' ban, ' + esc(q.fveto.picks) + ' picks)' : '');
  const cur = q.rewardCur || (q.prize && q.prize.currency) || 'USD';
  const rewards = [];
  if (q.prize) rewards.push('Overall ' + esc(formatPrize(q.prize)));
  for (const r of (q.rewardPlaces || [])) rewards.push(esc(r.place) + ': ' + esc(r.text || '') + (r.amount != null ? ' (' + esc(formatPrize({ currency: cur, amount: r.amount })) + ')' : ''));
  if (q.rewards) rewards.push('<span class="muted">' + esc(stripMd(q.rewards)) + '</span>');
  const cell = (label, body) => '<div class="prop-cell"><div class="ic-label">' + label + '</div><div class="small">' + body + '</div></div>';
  return `<div class="prop-card" data-propcard="${esc(q.id)}">
    <div class="prop-card-head"><a href="/t/${esc(q.id)}" data-link class="prop-card-name">${esc(q.name)}</a>
      <span class="muted small">by <strong>${esc(q.by)}</strong> &middot; proposed ${esc(fmtDateTime(q.proposedAt))} &middot; ${esc(propLeftText(q.until))}</span></div>
    ${q.note ? '<p class="prop-note">' + esc(q.note) + '</p>' : ''}
    <div class="prop-grid">
      ${cell('Format', fmt)}
      ${cell('When', when)}
      ${cell('Signups', esc(signups.join(', ')))}
      ${cell('Rating', esc(rating.join(', ')))}
      ${cell('Maps', maps + (pools ? '<div class="prop-pools">' + pools + '</div>' : ''))}
      ${cell('Rewards', rewards.length ? rewards.join('<br>') : '<span class="muted">none</span>')}
      ${q.mods || q.lobbyOptions ? cell('Mods and lobby', (q.mods ? esc(stripMd(q.mods)) : '') + (q.mods && q.lobbyOptions ? '<br>' : '') + (q.lobbyOptions ? '<span class="muted">' + esc(stripMd(q.lobbyOptions)) + '</span>' : '')) : ''}
    </div>
    ${q.description ? '<div class="prop-desc"><div class="ic-label">Description</div><div class="small">' + esc(stripMd(q.description)) + '</div></div>' : ''}
    ${propAnswersHTML(q, false)}
    ${q.mine ? '<p class="muted small" style="margin:6px 0 0">You proposed it (or organize it), so another director decides on it.</p>' : `<div class="pub-actions">
      <a href="/t/${esc(q.id)}" data-link class="btn ghost small">Open it</a>
      <button class="btn primary small" data-proptake="${esc(q.id)}">Take it over&hellip;</button>
      <button class="btn danger small" data-propdecl="${esc(q.id)}">Decline&hellip;</button>
    </div>
    <div class="pub-reject" data-propdeclbox="${esc(q.id)}" hidden>
      <textarea rows="2" maxlength="300" placeholder="What is missing or has to change - ${esc(q.by)} sees this"></textarea>
      <button class="btn danger small" data-propdeclgo="${esc(q.id)}">Decline</button>
    </div>`}
  </div>`;
}

const PROP_ACT_LABEL = { taken: 'taken over', declined: 'declined', timeout: 'came back (timeout)', withdrawn: 'withdrawn', released: 'given back',
  'unlocked maps': 'maps unlocked', 'unlocked format': 'format unlocked' };

function drawSaProposals(el) {
  const q = (saData && saData.proposals) || { pending: [], recent: [], days: 28, daysDefault: 28 };
  const recent = q.recent.map(r => `<tr>
      <td><a href="/t/${esc(r.id)}" data-link>${esc(r.name)}</a> <span class="muted small">by ${esc(r.proposer)}</span></td>
      <td>${esc(PROP_ACT_LABEL[r.act] || r.act)}</td>
      <td>${esc(r.byName)}</td>
      <td class="muted small">${esc(fmtDateTime(r.at))}</td>
      <td class="small">${esc(r.reason || '')}</td>
    </tr>`).join('');
  el.innerHTML = `<div class="panel section">
    <h2>Proposals waiting for a <span class="h2-strong">TD</span> (${q.pending.length})</h2>
    <p class="muted small">Players build tournaments and propose them for the TD team to run. Take one over ("I will TD this") and you become its organizer; decline it and say what is missing, and it goes back to its proposer to fix. A proposal nobody decides on within ${esc(q.days)} days goes back too. Publishing a taken-over proposal still needs a second director, not the one who took it over.</p>
    ${q.pending.length ? q.pending.map(proposalCardHTML).join('') : '<div class="empty">Nothing is waiting.</div>'}
  </div>
  <div class="panel section">
    <h2>Recent <span class="h2-strong">decisions</span></h2>
    ${q.recent.length ? `<div class="ban-table-wrap"><table class="sa-log"><thead><tr><th>Proposal</th><th>What</th><th>By</th><th>When</th><th></th></tr></thead><tbody>${recent}</tbody></table></div>` : '<div class="empty">No decisions yet.</div>'}
  </div>
  <div class="panel section">
    <h2>How long a proposal <span class="h2-strong">waits</span></h2>
    <div class="row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span>Back to its proposer after</span>
      <input type="number" id="propDays" min="7" max="90" value="${esc(q.days)}" style="width:90px">
      <span>days without a decision</span>
      <button class="btn small" id="propDaysGo">Save</button>
      <span class="muted small">(default ${esc(q.daysDefault)})</span>
    </div>
  </div>`;
  el.querySelectorAll('[data-link]').forEach(a => a.onclick = (e) => { e.preventDefault(); nav(a.getAttribute('href')); });
  const again = async () => { await renderSiteAdmin(); };
  el.querySelectorAll('[data-proptake]').forEach(b => b.onclick = () => {
    const p = q.pending.find(x => x.id === b.dataset.proptake);
    if (p) openTakeDialog({ id: p.id, name: p.name, by: p.by, keep: p.keep, lockMaps: p.lockMaps, lockFormat: p.lockFormat }, again);
  });
  el.querySelectorAll('[data-propdecl]').forEach(b => b.onclick = () => {
    const box = el.querySelector('[data-propdeclbox="' + b.dataset.propdecl + '"]');
    if (box) { box.hidden = false; box.querySelector('textarea').focus(); }
  });
  el.querySelectorAll('[data-propdeclgo]').forEach(b => b.onclick = async () => {
    const box = el.querySelector('[data-propdeclbox="' + b.dataset.propdeclgo + '"]');
    const why = box ? box.querySelector('textarea').value.trim() : '';
    if (!why) return toast('Say what is missing or has to change', true);
    try { await api('/api/t/' + b.dataset.propdeclgo + '/proposal_decline', { reason: why }); toast('Declined - it went back with your reason'); await again(); }
    catch (e) { toast(e.message, true); }
  });
  const dg = el.querySelector('#propDaysGo');
  if (dg) dg.onclick = async () => {
    try { const r = await saPost('proposal_days', { days: el.querySelector('#propDays').value }); toast('Proposals now wait ' + r.days + ' days'); await again(); }
    catch (e) { toast(e.message, true); }
  };
}

// For whoever runs it (not the proposer): what the proposer asked to keep, where the controls are.
// `area` 'maps' (Maps tab, the veto panels) or 'format' (Format panel); `brief` for a second line.
function proposalLockNoticeHTML(area, brief) {
  const P = T && T.proposal;
  if (!P || P.state !== 'taken' || P.mine) return '';
  if (area === 'maps' ? !P.lockMaps : !P.lockFormat) return '';
  const what = area === 'maps' ? 'the maps, map pools and vetoes' : 'the format and bracket (bracket type, team size, match lengths, divisions, 3rd place, the playoff and early-end settings)';
  return '<div class="panel prop-lock-note' + (brief ? ' brief' : '') + '"><strong>Kept as proposed.</strong> ' + esc(P.byName) + ' proposed this tournament and asked that ' + esc(what) +
    ' stay as they set them: saving a change is refused until they lift that' + (P.canUnlock ? ' (you can, as a site admin: Proposal box above the tabs)' : '') + '. Running the event is yours as usual.</div>';
}

// The start dialog, when the proposer kept the format: the server starts it with the proposed
// lengths whatever the dialog says, so the dialog shows them and does not offer to change them.
function lockStartDialog(root) {
  const P = T && T.proposal;
  if (!P || P.state !== 'taken' || !P.lockFormat || P.mine) return;
  root.querySelectorAll('select, input').forEach(i => { i.disabled = true; });
  const h = root.querySelector('h3');
  if (h) h.insertAdjacentHTML('afterend', '<p class="warn small">' + esc(P.byName) + ' asked that the format stay as proposed, so it starts with the lengths below.</p>');
}
