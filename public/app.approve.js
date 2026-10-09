// Publishing with a second account, and the allowed link sites (decision 51).
//
// With FAF login on, nobody publishes their own tournament. An organizer REQUESTS it; a tournament
// director or site admin who did not request it and did not write any of it reads it and approves it
// (now, or at the time that was requested) or rejects it with a reason. The server holds every
// rule (publish_request / publish_withdraw / publish_approve / publish_reject); this file draws
// the draft banner, the approver's box, the home page chips and the console's Approvals and
// Allowed links tabs. Without FAF login the old one-click publish stays (legacyDraftBannerHTML).

function approvalsOn() { return !!(fafAuth && fafAuth.approvals); }

// The old banner, for a site running without FAF login: publish now or on a schedule.
function legacyDraftBannerHTML() {
  return `<div class="panel" style="border-color:var(--amber);margin-top:12px">
        <strong>Draft — not public yet.</strong>
        <p class="muted small" style="margin:6px 0 10px">Only people with the link below can see this. Publish it to list it on the home page and open it up.</p>
        ${pubDayQuestionHTML()}
        <div class="copybox"><input type="text" readonly value="${location.origin}/t/${T.id}"><button class="btn small" data-copy="${location.origin}/t/${T.id}">Copy share link</button></div>
        ${T.publishAt ? `<div class="pub-sched"><span>⏱ Scheduled to publish automatically on <strong>${esc(fmtDateTime(T.publishAt))}</strong></span>
          <button class="btn ghost small" id="pubCancel">Cancel schedule</button></div>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <button class="btn primary" id="pubBtn">Publish now</button>
          <div>
            <label class="muted small" style="display:block">Or schedule (UTC)</label>
            <div style="display:flex;gap:6px">
              <input type="date" id="pubDate"><input type="time" id="pubTime">
              <button class="btn ghost" id="pubSchedBtn">Schedule</button>
            </div>
          </div>
        </div>
      </div>`;
}

// A multi-day draft must answer the start-time question first (decision 46).
function pubDayQuestionHTML() {
  return eventDayList(T).length && !T.dayTimesMode
    ? '<p class="warn small" style="margin:0 0 10px">Before publishing: this event runs on ' + eventDayList(T).length + ' days. Answer <strong>Different start times per day?</strong> under Tournament details (<a href="#" data-adminjump="info" data-adminfocus="td_dayTimes">Admin tab → Info</a>).</p>'
    : '';
}

// Everything above the tabs on a draft: the organizers' banner and, for whoever may decide,
// the approval box. `admin` = the viewer organizes this tournament.
function draftBannerHTML(admin) {
  if (!approvalsOn()) return admin ? legacyDraftBannerHTML() : '';
  const P = T.pub || {};
  let out = '';
  if (admin) {
    out += `<div class="panel pub-banner" style="border-color:var(--amber);margin-top:12px">
      <strong>Draft - not public yet.</strong>
      <p class="muted small" style="margin:6px 0 10px">Only people with the link below can see this. Publishing needs a second account: request it, and a tournament director who did not write any of it reads it and approves it (or rejects it with a reason). That way no single account can put something in public.</p>
      ${pubDayQuestionHTML()}
      <div class="copybox"><input type="text" readonly value="${location.origin}/t/${T.id}"><button class="btn small" data-copy="${location.origin}/t/${T.id}">Copy share link</button></div>
      ${pubStatusHTML(P)}
      ${pubControlsHTML(P)}
    </div>`;
  }
  if (P.approver && P.req) out += approverBoxHTML(P);
  return out;
}

// Where the request stands, in one or two lines.
function pubStatusHTML(P) {
  const when = iso => iso ? 'on <strong>' + esc(fmtDateTime(iso)) + '</strong>' : 'as soon as it is approved';
  if (P.req && P.req.stale) {
    return '<div class="pub-state pub-warn">⚠ Changed since <strong>' + esc(P.req.byName) + '</strong> requested it on ' + esc(fmtDateTime(P.req.at)) +
      '. A director can only approve what was requested, so request it again.</div>';
  }
  if (P.req) {
    return '<div class="pub-state pub-wait">⏳ Waiting for a tournament director to approve it. Requested by <strong>' + esc(P.req.byName) +
      '</strong> on ' + esc(fmtDateTime(P.req.at)) + ', to publish ' + when(P.req.publishAt) + '.</div>';
  }
  if (P.approved && P.approved.stale) {
    return '<div class="pub-state pub-warn">⚠ Changed after <strong>' + esc(P.approved.byName) + '</strong> approved it, so it will not publish on ' +
      esc(fmtDateTime(P.approved.publishAt)) + '. Request it again.</div>';
  }
  if (P.approved) {
    return '<div class="pub-state pub-ok">✓ Approved by <strong>' + esc(P.approved.byName) + '</strong> on ' + esc(fmtDateTime(P.approved.at)) +
      ' (requested by ' + esc(P.approved.reqByName || '') + '). It publishes by itself ' + when(P.approved.publishAt) + '.</div>';
  }
  let h = '';
  if (P.rejected) {
    h += '<div class="pub-state pub-no">✗ Rejected by <strong>' + esc(P.rejected.byName) + '</strong> on ' + esc(fmtDateTime(P.rejected.at)) +
      ': <em>' + esc(P.rejected.reason) + '</em>. Fix it and request it again.</div>';
  }
  if (P.oldSchedule) {
    h += '<div class="pub-state pub-warn">⏱ Scheduled for <strong>' + esc(fmtDateTime(P.oldSchedule)) +
      '</strong> before publishing needed approval. It will not publish until a director approves it: request it below.</div>';
  }
  return h;
}

// Request (now or for a time), request again, withdraw.
function pubControlsHTML(P) {
  const stale = (P.req && P.req.stale) || (P.approved && P.approved.stale);
  const canAsk = (!P.req && !P.approved) || stale;
  let h = '<div class="pub-actions">';
  if (canAsk) {
    const def = (P.req && P.req.publishAt) || (P.approved && P.approved.publishAt) || P.oldSchedule || null;
    const d = def ? splitDateTimeUTC(def) : { date: '', time: '' };
    h += '<button class="btn primary" id="pubAsk">' + (stale ? 'Request again' : 'Request to publish') + '</button>' +
      '<div><label class="muted small" style="display:block">Or at a time (UTC)</label><div style="display:flex;gap:6px">' +
      '<input type="date" id="pubDate" value="' + esc(d.date) + '"><input type="time" id="pubTime" value="' + esc(d.time) + '">' +
      '<button class="btn ghost" id="pubAskAt">Request for this time</button></div></div>';
  }
  if (P.req || P.approved || P.oldSchedule) {
    h += '<button class="btn ghost" id="pubWithdraw">' + (P.approved ? 'Cancel publishing' : P.req ? 'Withdraw the request' : 'Drop the old schedule') + '</button>';
  }
  return h + '</div>';
}

// What the approver had in front of them when they first looked: the fingerprint of the content on
// their first sight of the request (this visit). Approving sends THIS one, not the latest: the
// 4-second refresh redraws the page quietly, so a version changed and requested again while the
// page was open is refused until they have seen that it changed. Reset on every fresh visit to a
// tournament page (renderTournament).
let _pubSeen = null;   // { tid, fp }

// For a director or site admin: who requested it, who wrote it, approve or reject.
function approverBoxHTML(P) {
  const r = P.req;
  if (P.fp && (!_pubSeen || _pubSeen.tid !== T.id)) _pubSeen = { tid: T.id, fp: P.fp };
  const changed = !r.stale && !!P.fp && !!_pubSeen && _pubSeen.fp !== P.fp;
  let action;
  if (r.stale) action = '<p class="muted small" style="margin:0">It changed after it was requested. Waiting for an organizer to request it again.</p>';
  else if (!P.canApprove) {
    action = '<p class="warn small" style="margin:0">' + (P.why === 'requested'
      ? 'You requested this yourself, so another tournament director has to approve it.'
      : P.why === 'edited'
        ? 'You changed this tournament yourself, so another tournament director has to approve it.'
        : P.why === 'new'
          ? 'You got this role less than 3 days ago, so you can approve publishing from ' + esc(fmtDateTime(P.from)) + '. Until then another tournament director has to. (A stolen account must not be able to add a second account of its own and approve with it.)'
          : 'You cannot approve this.') + '</p>';
  } else {
    action = '<button class="btn primary" id="pubApprove">' + (r.publishAt ? 'Approve for ' + esc(fmtDateTime(r.publishAt)) : 'Approve and publish') + '</button>';
  }
  const reject = P.why === 'requested' ? '' : '<button class="btn danger" id="pubRejectOpen">Reject…</button>';
  return `<div class="panel approve-box" style="margin-top:12px">
    <div class="mono small approve-head">PUBLISH REQUEST</div>
    <p style="margin:6px 0">Requested by <strong>${esc(r.byName)}</strong> on ${esc(fmtDateTime(r.at))}, to publish ${r.publishAt ? 'on <strong>' + esc(fmtDateTime(r.publishAt)) + '</strong>' : 'as soon as it is approved'}.</p>
    ${(P.writers || []).length ? '<p class="muted small" style="margin:0 0 6px">Written by: ' + P.writers.map(esc).join(', ') + '</p>' : ''}
    <p class="muted small" style="margin:0 0 10px">Read everything players will see before approving: the Overview (rules, rewards, sponsors, livestreams), the News and the Maps. Links to sites that are not allowed show as plain text.</p>
    ${changed && P.canApprove ? '<p class="warn small" style="margin:0 0 8px">⚠ It changed since you opened this page, and ' + esc(r.byName) + ' requested it again on ' + esc(fmtDateTime(r.at)) + '. Read it again before approving.</p>' : ''}
    <div class="pub-actions">${action}${reject}</div>
    <div id="pubRejectBox" class="pub-reject" hidden>
      <textarea id="pubRejectWhy" rows="2" maxlength="300" placeholder="What has to change - the organizers see this"></textarea>
      <button class="btn danger small" id="pubRejectGo">Reject</button>
    </div>
  </div>`;
}

function wireDraftBanner() {
  const $ = id => document.getElementById(id);
  const request = async (publishAt) => {
    try {
      const r = await api('/api/t/' + T.id + '/publish_request', publishAt ? { publishAt } : {});
      toast(r.publishAt
        ? 'Requested: it publishes on ' + fmtDateTime(r.publishAt) + ' once a tournament director approves it'
        : 'Requested - a tournament director has to approve it');
      await refresh();
    } catch (e) { toast(e.message, true); }
  };
  if ($('pubAsk')) $('pubAsk').onclick = () => request(null);
  if ($('pubAskAt')) $('pubAskAt').onclick = () => {
    const dEl = $('pubDate'), tEl = $('pubTime');
    if (!dEl.value) return toast('Pick a date', true);
    const iso = combineDateTimeUTC(dEl, tEl);
    if (!iso) return toast('Invalid date/time', true);
    request(iso);
  };
  if ($('pubWithdraw')) $('pubWithdraw').onclick = async () => {
    try { await api('/api/t/' + T.id + '/publish_withdraw', {}); toast('Done - it stays a draft'); await refresh(); }
    catch (e) { toast(e.message, true); }
  };
  if ($('pubApprove')) $('pubApprove').onclick = async () => {
    const r0 = (T.pub && T.pub.req) || {};
    if (!confirm(r0.publishAt
      ? 'Approve "' + T.name + '"? It publishes by itself on ' + fmtDateTime(r0.publishAt) + '.'
      : 'Approve "' + T.name + '"? It goes public on the home page straight away.')) return;
    const seen = (_pubSeen && _pubSeen.tid === T.id) ? _pubSeen.fp : ((T.pub && T.pub.fp) || '');
    try {
      const r = await api('/api/t/' + T.id + '/publish_approve', { fp: seen });
      toast(r.published ? 'Approved - it is public now' : 'Approved - it publishes on ' + fmtDateTime(r.publishAt));
      await refresh();
    } catch (e) {
      toast(e.message, true);
      // Refused because it changed while they were looking: they have now been told, so the next
      // approval is for the version on the page.
      if (/while you were looking/.test(e.message)) {
        try { await refresh(); } catch (e2) {}
        if (T.pub && T.pub.fp) _pubSeen = { tid: T.id, fp: T.pub.fp };
        redrawInPlace();
      }
    }
  };
  if ($('pubRejectOpen')) $('pubRejectOpen').onclick = () => { $('pubRejectBox').hidden = false; $('pubRejectWhy').focus(); };
  if ($('pubRejectGo')) $('pubRejectGo').onclick = async () => {
    const why = $('pubRejectWhy').value.trim();
    if (!why) return toast('Say what has to change', true);
    try { await api('/api/t/' + T.id + '/publish_reject', { reason: why }); toast('Rejected - the organizers see why'); await refresh(); }
    catch (e) { toast(e.message, true); }
  };
}

// The chip a draft's card carries on the home page.
function pubChipHTML(t) {
  const p = t.pub;
  if (!p || !approvalsOn()) return '';
  if (p.s === 'asked') return '<span class="idbadge pubchip pub-wait" title="Requested by ' + esc(p.by || '') + ' on ' + esc(fmtDateTime(p.at)) + '">waiting for approval</span>';
  if (p.s === 'stale') return '<span class="idbadge pubchip pub-warn" title="Changed after publishing was requested or approved: an organizer has to request it again">changed since requested</span>';
  if (p.s === 'approved') return '<span class="idbadge pubchip pub-ok" title="Approved. Publishes by itself on ' + esc(fmtDateTime(p.at)) + '">approved</span>';
  if (p.s === 'rejected') return '<span class="idbadge pubchip pub-no" title="Rejected by ' + esc(p.by || '') + '">rejected</span>';
  return '';
}

// ---------- console: Approvals ----------
function drawSaApprovals(el) {
  const q = (saData && saData.publishing) || { pending: [], decided: [] };
  const link = (t) => '<a href="/t/' + esc(t.id) + '" data-link>' + esc(t.name) + '</a>' + (t.category ? ' <span class="catbox ' + (t.category === 'official' ? 'official' : 'community') + '">' + esc(t.category.toUpperCase()) + '</span>' : '');
  const state = (t) => t.stale ? '<span class="idbadge pubchip pub-warn">changed since requested</span>'
    : t.can ? '<a href="/t/' + esc(t.id) + '" data-link class="btn small primary">Review</a>'
    : t.why === 'requested' ? '<span class="muted small">you requested it</span>'
    : t.why === 'edited' ? '<span class="muted small">you wrote part of it</span>'
    : t.why === 'new' ? '<span class="muted small" title="New tournament directors and site admins wait 3 days before they can approve">you can approve from ' + esc(fmtDateTime(t.from)) + '</span>'
    : '<span class="muted small">-</span>';
  const pending = q.pending.map(t => `<tr>
      <td>${link(t)}${t.imported ? ' <span class="muted small">(imported)</span>' : ''}</td>
      <td>${esc(t.by)}</td>
      <td class="muted small">${esc(fmtDateTime(t.at))}</td>
      <td class="small">${t.publishAt ? esc(fmtDateTime(t.publishAt)) : 'when approved'}</td>
      <td class="small">${(t.writers || []).map(esc).join(', ')}</td>
      <td>${state(t)}</td>
    </tr>`).join('');
  const decided = q.decided.map(t => `<tr>
      <td>${link(t)}</td>
      <td>${t.result === 'approved' ? '<span class="idbadge pubchip pub-ok">approved</span>' : '<span class="idbadge pubchip pub-no">rejected</span>'}</td>
      <td>${esc(t.by)}</td>
      <td>${esc(t.reqBy || '')}</td>
      <td class="muted small">${esc(fmtDateTime(t.at))}</td>
      <td class="small">${t.result === 'rejected' ? esc(t.reason || '') : (t.publishAt && !t.published ? 'publishes ' + esc(fmtDateTime(t.publishAt)) : '')}</td>
    </tr>`).join('');
  el.innerHTML = `<div class="panel section">
    <h2>Waiting for <span class="h2-strong">approval</span> (${q.pending.length})</h2>
    <p class="muted small">Every tournament needs a second account before it goes public: a director or site admin who did not request it and did not write any of it (and has had the role for 3 days). Open one, read what players will see, then approve or reject it on its page. Everything is in the Logs.</p>
    ${q.pending.length ? `<div class="ban-table-wrap"><table class="sa-log"><thead><tr><th>Tournament</th><th>Requested by</th><th>When</th><th>Publishes</th><th>Written by</th><th></th></tr></thead><tbody>${pending}</tbody></table></div>` : '<div class="empty">Nothing is waiting.</div>'}
  </div>
  <div class="panel section">
    <h2>Recent <span class="h2-strong">decisions</span></h2>
    ${q.decided.length ? `<div class="ban-table-wrap"><table class="sa-log"><thead><tr><th>Tournament</th><th>Result</th><th>By</th><th>Requested by</th><th>When</th><th></th></tr></thead><tbody>${decided}</tbody></table></div>` : '<div class="empty">No decisions yet.</div>'}
  </div>`;
  el.querySelectorAll('[data-link]').forEach(a => a.onclick = (e) => { e.preventDefault(); nav(a.getAttribute('href')); });
}

// ---------- console: Allowed links ----------
function drawSaLinks(el) {
  const sites = ((saData && saData.linkSites) || []).slice().sort();
  const defaults = (saData && saData.linkSitesDefault) || [];
  const differs = sites.slice().sort().join() !== defaults.slice().sort().join();
  el.innerHTML = `<div class="panel section">
    <h2>Allowed <span class="h2-strong">links</span> (${sites.length})</h2>
    <p class="muted small">Text people write on this site (tournament descriptions, rewards, sponsors, lobby options, mods, livestreams, news, series and the FAQ) may only link to these sites, or show pictures from them. A site includes its subdomains: <strong>faforever.com</strong> also covers forum.faforever.com. Saving a link to any other site is refused, and older links to other sites are shown as plain text. Every change is in the Logs.</p>
    ${sites.length ? '<div class="pick-rows" style="margin-top:10px">' + sites.map(s => `<div class="pick-row on" style="cursor:default">
      <span class="pr-name">${esc(s)}</span>
      <button class="btn danger small" data-linkdel="${esc(s)}">Remove</button>
    </div>`).join('') + '</div>' : '<div class="empty">No site is allowed: no links work anywhere.</div>'}
    <div class="row" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <input type="text" id="linkAdd" placeholder="e.g. twitch.tv" maxlength="120" style="flex:1;min-width:200px" autocomplete="off">
      <button class="btn" id="linkAddGo">Allow</button>
    </div>
    ${differs ? '<p class="muted small" style="margin-top:10px">The starting list was: ' + defaults.map(esc).join(', ') + '.</p>' : ''}
  </div>`;
  const save = async (act, site) => {
    try {
      const r = await saPost(act, { site });
      saData.linkSites = r.sites;
      if (fafAuth) fafAuth.linkSites = r.sites;   // this page renders with the new list right away
      toast(act === 'link_add' ? 'Allowed' : 'Removed');
      drawSaLinks(el);
    } catch (e) { toast(e.message, true); }
  };
  const go = el.querySelector('#linkAddGo');
  if (go) go.onclick = () => save('link_add', el.querySelector('#linkAdd').value);
  const inp = el.querySelector('#linkAdd');
  if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save('link_add', inp.value); });
  el.querySelectorAll('[data-linkdel]').forEach(b => b.onclick = () => {
    if (!confirm('Remove ' + b.dataset.linkdel + '? Links to it stop working everywhere on the site.')) return;
    save('link_remove', b.dataset.linkdel);
  });
}
