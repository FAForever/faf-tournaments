// ---------- home page: calendar ----------
// A month view of the same (filtered) list the home page shows, for planning a season at a
// glance. Each tournament sits on the day(s) it runs, at its start time in the viewer's time zone
// (multi-day events once per day, with each day's own time). Organizers drag a tournament that
// has not started to another day to move it - the server moves its whole timeline along
// (lib/schedule.js). Drafts can be shown or hidden. On a phone the grid becomes an agenda list.

let _calMonth = null;     // 'YYYY-MM' on screen; module level so a redraw keeps the month
let _calDrag = null;      // { id, fromDay } while a chip is being dragged

function calShowDrafts() {
  try { return localStorage.getItem('faf_cal_drafts') !== '0'; } catch (e) { return true; }
}
function setCalShowDrafts(on) { try { localStorage.setItem('faf_cal_drafts', on ? '1' : '0'); } catch (e) {} }

// 'YYYY-MM-DD' of an instant in the viewer's chosen zone
function calLocalYmd(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: resolvedTZ(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
}
function calDaysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// Every day a tournament occupies: [{ ymd (viewer's day), iso (start or null), n, of }]
function calOccurrences(t) {
  const starts = dayStartList(t);
  if (starts.length) {
    return starts.map(s => ({ ymd: s.iso ? calLocalYmd(Date.parse(s.iso)) : s.day, iso: s.iso, n: s.n, of: starts.length }));
  }
  const v = tourneyDate(t);
  if (!v) return [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return [{ ymd: v, iso: null, n: 1, of: 1 }];
  const ms = Date.parse(v);
  if (isNaN(ms)) return [];
  return [{ ymd: calLocalYmd(ms), iso: new Date(ms).toISOString(), n: 1, of: 1 }];
}

// Moving needs organizer rights and a tournament that has not started (the server says the same).
function calCanMove(t) {
  return t.canManage === 1 && t.status === 'signup' && !t.abandoned && !t.imported;
}

function calChipHTML(t, o) {
  const cls = ['cal-chip', t.category === 'official' ? 'official' : 'community'];
  if (t.published === 0) cls.push('is-draft');
  if (t.me && (t.me.org || t.me.player || t.me.caster)) cls.push('is-mine');
  if (t.abandoned) cls.push('is-abandoned');
  const time = o && o.iso ? fmtTimePart(new Date(o.iso), resolvedTZ()) : '';
  const move = calCanMove(t);
  const when = o ? (o.iso ? fmtWeekdayDateTime(o.iso) : fmtWeekdayDateTime(o.ymd)) : 'No date yet';
  const tip = [t.name,
    when + (o && o.of > 1 ? ' (day ' + o.n + ' of ' + o.of + ')' : ''),
    (t.category === 'official' ? 'Official' : 'Community') + ' · ' + homeSizeLabel(homeSizeKey(t)) + ' · ' + statusPillLabel(t),
    t.seriesName ? 'Series: ' + t.seriesName : '',
    t.published === 0 ? 'Draft - not published yet' : '',
    move ? 'Drag to another day to move it' : ''].filter(Boolean).join('\n');
  const roles = t.me ? [t.me.org ? 'TO' : '', t.me.player ? 'PLAYER' : '', t.me.caster ? 'CASTER' : ''].filter(Boolean).join(' ') : '';
  return `<a class="${cls.join(' ')}" href="/t/${esc(t.id)}" draggable="${move ? 'true' : 'false'}" data-calid="${esc(t.id)}" data-calday="${o ? esc(o.ymd) : ''}" title="${esc(tip)}">`
    + (time ? '<span class="cal-time">' + esc(time) + '</span>' : '')
    + '<span class="cal-name">' + esc(t.name) + '</span>'
    + (o && o.of > 1 ? '<span class="cal-n">' + o.n + '/' + o.of + '</span>' : '')
    + (roles ? '<span class="cal-role">' + esc(roles) + '</span>' : '')
    + '</a>';
}

function drawHomeCalendar(body, list) {
  // Drafts reach the browser only for people who may see them, so "can see any draft" is simply
  // whether the unfiltered list has one.
  const seesDrafts = _homeList.some(t => t.published === 0);
  const showDrafts = seesDrafts && calShowDrafts();
  const items = list.filter(t => t.published !== 0 || showDrafts);
  if (!_calMonth) {
    // the month you were planning stays put across a reload (per tab)
    try { const m = sessionStorage.getItem('faf_cal_month'); if (/^\d{4}-\d{2}$/.test(m || '')) _calMonth = m; } catch (e) {}
    if (!_calMonth) _calMonth = calLocalYmd(Date.now()).slice(0, 7);
  }
  try { sessionStorage.setItem('faf_cal_month', _calMonth); } catch (e) {}
  const [vy, vm] = _calMonth.split('-').map(Number);
  const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][vm - 1];
  const firstYmd = _calMonth + '-01';
  const lead = (new Date(Date.UTC(vy, vm - 1, 1)).getUTCDay() + 6) % 7;            // Monday first
  const nDays = new Date(Date.UTC(vy, vm, 0)).getUTCDate();
  const weeks = Math.ceil((lead + nDays) / 7);
  const gridStart = dayAddUTC(firstYmd, -lead);
  const today = calLocalYmd(Date.now());

  const byDay = {};
  const undated = [];
  for (const t of items) {
    const occ = calOccurrences(t);
    if (!occ.length) { undated.push(t); continue; }
    for (const o of occ) (byDay[o.ymd] = byDay[o.ymd] || []).push({ t, o });
  }
  for (const k of Object.keys(byDay)) {
    byDay[k].sort((a, b) => (a.o.iso || '').localeCompare(b.o.iso || '') || String(a.t.name).localeCompare(String(b.t.name)));
  }
  const anyMovable = items.some(calCanMove);

  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const ymd = dayAddUTC(gridStart, i);
    const cls = ['cal-cell'];
    if (ymd.slice(0, 7) !== _calMonth) cls.push('out');
    if (ymd === today) cls.push('today');
    if (i % 7 >= 5) cls.push('wknd');
    const list2 = byDay[ymd] || [];
    cells += `<div class="${cls.join(' ')}" data-ymd="${ymd}">
      <div class="cal-daynum">${+ymd.slice(8)}</div>
      ${list2.map(x => calChipHTML(x.t, x.o)).join('')}
    </div>`;
  }

  // the phone version: only the days that have something, in order
  let agenda = '';
  for (let d = 1; d <= nDays; d++) {
    const ymd = _calMonth + '-' + String(d).padStart(2, '0');
    const list2 = byDay[ymd];
    if (!list2 || !list2.length) continue;
    agenda += `<div class="cal-ag-day${ymd === today ? ' today' : ''}"><div class="cal-ag-date">${esc(fmtWeekdayDateTime(ymd))}</div>
      ${list2.map(x => calChipHTML(x.t, x.o)).join('')}</div>`;
  }

  body.innerHTML = `<div class="panel section cal">
    <div class="cal-head">
      <button type="button" class="btn ghost small cal-nav" data-calmove="-1" title="Previous month">‹</button>
      <h2 class="cal-title">${esc(monthName)} <span class="h2-strong">${vy}</span></h2>
      <button type="button" class="btn ghost small cal-nav" data-calmove="1" title="Next month">›</button>
      <button type="button" class="btn ghost small" data-caltoday>Today</button>
      <span class="cal-spacer"></span>
      ${seesDrafts ? `<label class="cal-toggle"><input type="checkbox" id="calDrafts"${showDrafts ? ' checked' : ''}> Show drafts</label>` : ''}
    </div>
    <div class="cal-legend muted small">
      <span class="cal-key official">Official</span><span class="cal-key community">Community</span>${seesDrafts ? '<span class="cal-key is-draft">Draft</span>' : ''}<span class="cal-key is-mine">Yours</span>
      ${anyMovable ? '<span class="cal-hint">Drag a tournament to another day to move it. Signups and check-in move with it.</span>' : ''}
    </div>
    <div class="cal-grid-wrap">
      <div class="cal-grid cal-dows">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => '<div class="cal-dow">' + x + '</div>').join('')}</div>
      <div class="cal-grid">${cells}</div>
    </div>
    <div class="cal-agenda">${agenda || '<div class="empty">Nothing this month.</div>'}</div>
    ${undated.length ? `<div class="cal-undated" data-ymd="">
      <div class="cal-undated-title">No date yet <span class="muted small">(${undated.length})</span>${undated.some(calCanMove) ? ' <span class="muted small">- drag one onto a day to give it a date</span>' : ''}</div>
      <div class="cal-undated-list">${undated.map(t => calChipHTML(t, null)).join('')}</div>
    </div>` : ''}
  </div>`;

  body.querySelectorAll('[data-calmove]').forEach(b => b.onclick = () => {
    const d = new Date(Date.UTC(vy, vm - 1 + (+b.dataset.calmove), 1));
    _calMonth = d.toISOString().slice(0, 7);
    drawHomeCalendar(body, list);
  });
  const tb = body.querySelector('[data-caltoday]');
  if (tb) tb.onclick = () => { _calMonth = calLocalYmd(Date.now()).slice(0, 7); drawHomeCalendar(body, list); };
  const dr = body.querySelector('#calDrafts');
  if (dr) dr.onchange = () => { setCalShowDrafts(dr.checked); drawHomeCalendar(body, list); };

  // ---- drag and drop (desktop; the agenda has none) ----
  body.querySelectorAll('.cal-chip[draggable="true"]').forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      _calDrag = { id: chip.dataset.calid, fromDay: chip.dataset.calday || '' };
      chip.classList.add('dragging');
      body.querySelector('.cal').classList.add('cal-dragging');
      try { e.dataTransfer.setData('text/plain', chip.dataset.calid); e.dataTransfer.effectAllowed = 'move'; } catch (er) {}
    });
    chip.addEventListener('dragend', () => {
      chip.classList.remove('dragging');
      const c = body.querySelector('.cal');
      if (c) c.classList.remove('cal-dragging');
      body.querySelectorAll('.drop-on').forEach(x => x.classList.remove('drop-on'));
      _calDrag = null;
    });
  });
  body.querySelectorAll('.cal-grid .cal-cell').forEach(cell => {
    cell.addEventListener('dragover', (e) => {
      if (!_calDrag) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (er) {}
      cell.classList.add('drop-on');
    });
    cell.addEventListener('dragleave', (e) => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('drop-on'); });
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('drop-on');
      const drag = _calDrag;
      _calDrag = null;
      if (drag) calMoveTo(drag, cell.dataset.ymd);
    });
  });
}

// Ask the server to move it. A published tournament has people signed up for that date, so it
// asks first; a draft just moves.
function calMoveTo(drag, toYmd) {
  const t = _homeList.find(x => x.id === drag.id);
  if (!t || !toYmd) return;
  let body;
  if (drag.fromDay) {
    const n = calDaysBetween(drag.fromDay, toYmd);
    if (!n) return;
    body = { days: n };
  } else {
    body = { date: toYmd };
  }
  const target = fmtWeekdayDateTime(toYmd);
  const go = async () => {
    try {
      const tok = (() => { try { return localStorage.getItem('admin_' + t.id); } catch (e) { return null; } })();
      await api('/api/t/' + t.id + '/move_date', Object.assign({ admin: tok || siteAdmin() || undefined }, body));
      toast((drag.fromDay ? 'Moved to ' : 'Set to ') + target + ': ' + t.name);
      await renderHome();
    } catch (e) { toast(e.message, true); }
  };
  if (t.published === 0) { go(); return; }
  const n = t.players || 0;
  modal(`<h3>Move this tournament?</h3>
    <p><strong>${esc(t.name)}</strong> moves to <strong>${esc(target)}</strong>${body.days ? ' (' + Math.abs(body.days) + ' day' + (Math.abs(body.days) === 1 ? '' : 's') + ' ' + (body.days > 0 ? 'later' : 'earlier') + ')' : ''}.</p>
    <p class="muted small">It is published${n ? ' and ' + n + ' ' + (n === 1 ? 'player is' : 'players are') + ' signed up' : ''}. The start time stays the same; signup and check-in times move with it. Consider posting the change on its News tab.</p>
    <div class="actions"><button class="btn ghost" id="cmvNo">Cancel</button><button class="btn primary" id="cmvGo">Move it</button></div>`, root => {
    root.querySelector('#cmvNo').onclick = closeModal;
    root.querySelector('#cmvGo').onclick = () => { closeModal(); go(); };
  });
}
