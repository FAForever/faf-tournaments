// ---------- chat dock ----------
// The chats a viewer needs open on the right by themselves, as tabs, while they browse the
// bracket, matches and vetoes. It replaces the single "pinned" chat, which had to be opened by
// hand one room at a time.
//   Players:     their match chats (they pop up when a match is ready), plus Global and Captains
//                while the tournament is in progress. A match chat closes by itself once the
//                result is confirmed.
//   Organizers:  nothing by default - in a big round that would be dozens of tabs. A chat pops up
//                when someone pings the organizers in it (!organizer or the bell button). One who
//                also plays in their own event gets their own match chat like any player.
//   Everyone:    a chat where you are @mentioned pops up; any chat can be added by hand
//                (the pin button on the Chat tab and in a chat, or a match's chat link).
// A tab closed by hand stays closed until something new arrives in it for you. The dock can be
// minimized to a button; it is hidden on the Chat tab (which shows every chat already) and in
// streamer mode it never opens anything by itself, so a private room cannot pop up on stream.
// Only the visible chat polls for messages; the other tabs' badges come from the tournament poll
// (T.chatDock and T.unreadByRoom, built by the server).

let _dock = null;          // { tid, tabs: [{room, label, manual}], active, collapsed, dismissed: {room: lastMsgAt} }
let _dockMounted = null;   // room whose chat is mounted in the dock body

function dockStoreKey(tid) { return 'faf_dock_' + tid; }
function dockSave() {
  if (!_dock) return;
  try {
    sessionStorage.setItem(dockStoreKey(_dock.tid), JSON.stringify({
      tabs: _dock.tabs, active: _dock.active, collapsed: _dock.collapsed, dismissed: _dock.dismissed
    }));
  } catch (e) {}
}
function dockLoad(tid) {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(dockStoreKey(tid)) || 'null'); } catch (e) { s = null; }
  return {
    tid,
    tabs: (s && Array.isArray(s.tabs)) ? s.tabs.filter(x => x && typeof x.room === 'string') : [],
    active: (s && s.active) || null,
    collapsed: !!(s && s.collapsed),
    dismissed: (s && s.dismissed && typeof s.dismissed === 'object') ? s.dismissed : {}
  };
}

function dockRoomInfo(room) {
  return ((typeof T !== 'undefined' && T && T.chatDock) || []).find(r => r.id === room) || null;
}
function dockMatchOf(room) {
  if (!room || room.indexOf('match:') !== 0 || !T || !T.matches) return null;
  return T.matches.find(x => x.id === room.slice(6)) || null;
}
// Short tab names. For a player, a match is "vs <opponent>"; for staff, both sides.
function dockTabLabel(room, fallback) {
  if (room === 'global') return 'Global';
  if (room === 'captains') return 'Captains';
  if (room === 'staff') return 'Staff';
  const m = dockMatchOf(room);
  if (m) {
    const v = T.viewer || {};
    const mine = v.memberTeamId || v.teamId;
    if (mine && (m.team1 === mine || m.team2 === mine)) return 'vs ' + teamName(m.team1 === mine ? m.team2 : m.team1);
    return teamName(m.team1) + ' vs ' + teamName(m.team2);
  }
  return fallback || room;
}
// The full name, for the chat's own header and the tab's tooltip.
function dockRoomFull(room, fallback) {
  const r = dockRoomInfo(room);
  if (r && r.label) return r.label;
  const m = dockMatchOf(room);
  if (m) return (typeof mLabelFull === 'function' ? mLabelFull(m) + ' - ' : '') + teamName(m.team1) + ' vs ' + teamName(m.team2);
  return fallback || dockTabLabel(room);
}
// Global, Captains and Staff first, then the match chats in the order they opened.
function dockSortTabs() {
  const rank = r => r === 'global' ? 0 : r === 'captains' ? 1 : r === 'staff' ? 2 : 3;
  _dock.tabs = _dock.tabs.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x.room) - rank(b.x.room) || a.i - b.i).map(o => o.x);
}
// Someone is in the middle of writing in the dock: never switch the chat away from under them.
function dockTyping() {
  const inp = document.querySelector('#chatDock .js-chattext');
  return !!(inp && document.activeElement === inp && inp.value.trim());
}

// Called whenever the tournament data changes or the page is redrawn.
function dockSync() {
  const tid = typeof tourneyId === 'function' ? tourneyId() : null;
  if (!tid || typeof T === 'undefined' || !T || T.id !== tid) { dockTeardown(); return; }
  if (!_dock || _dock.tid !== tid) { dockTeardown(); _dock = dockLoad(tid); }
  dockAuto();
  dockRender();
}

function dockTeardown() {
  dockUnmount();
  const el = document.getElementById('chatDock');
  if (el) el.remove();
  document.body.classList.remove('chat-docked', 'chat-dock-min');
  if (_dock) dockSave();
  _dock = null;
}

// Open and close tabs by the rules in the header.
function dockAuto() {
  const v = T.viewer || {};
  const staff = !!(v.organizer || v.caster);
  const running = ['draft', 'drafted', 'running'].indexOf(T.status) >= 0;
  const rooms = T.chatDock || [];
  // 1. a match chat whose result is confirmed closes; so does a room a player lost access to
  for (const tab of _dock.tabs.slice()) {
    if (tab.room.indexOf('match:') === 0 && chatRoomIsDone(tab.room)) {
      dockRemove(tab.room, { keep: true, note: 'Chat closed: ' + dockTabLabel(tab.room, tab.label) + ' is complete.' });
    } else if (!staff && !rooms.some(r => r.id === tab.room)) {
      dockRemove(tab.room, { keep: true });
    }
  }
  if (typeof streamerMode !== 'undefined' && streamerMode) { dockSave(); return; }
  // 2. open what this viewer should see
  let popped = null;
  for (const r of rooms) {
    if (r.done || _dock.tabs.some(x => x.room === r.id)) continue;
    const isMatch = r.id.indexOf('match:') === 0;
    let want = false, important = false;
    if (r.mention) { want = true; important = true; }
    if (isMatch && r.mine) { want = true; important = true; }      // an organizer playing in their own event
    if (!staff) {
      if (isMatch) { want = true; important = true; }
      // in a 1v1 every entrant is a captain, so Captains is just a second Global there
      else if (running && (r.id !== 'captains' || (T.teamSize || 1) > 1)) want = true;
    } else if (v.organizer && r.ping) { want = true; important = true; }
    if (!want) continue;
    const dis = _dock.dismissed[r.id] || 0;
    if (dis) {
      // closed by hand: it comes back only with something new for this viewer
      const fresh = (r.last || 0) > dis && (r.mention || (v.organizer && r.ping) || (isMatch && (!staff || r.mine) && r.unread > 0));
      if (!fresh) continue;
      delete _dock.dismissed[r.id];
    }
    _dock.tabs.push({ room: r.id, label: r.label || '' });
    if (important && !popped) popped = r.id;
  }
  dockSortTabs();
  if (popped && !dockTyping()) { _dock.active = popped; _dock.collapsed = false; }
  if (_dock.active && !_dock.tabs.some(x => x.room === _dock.active)) _dock.active = null;
  if (!_dock.active && _dock.tabs.length) _dock.active = _dock.tabs[0].room;
  dockSave();
}

// opts.keep: closed by the dock itself, not by the user - it may open again by the normal rules
function dockRemove(room, opts) {
  if (!_dock) return;
  const i = _dock.tabs.findIndex(x => x.room === room);
  if (i < 0) return;
  _dock.tabs.splice(i, 1);
  if (!(opts && opts.keep)) {
    const r = dockRoomInfo(room);
    _dock.dismissed[room] = Math.max(1, (r && r.last) || 0);
  }
  if (_dock.active === room) _dock.active = ((_dock.tabs[i] || _dock.tabs[i - 1]) || {}).room || null;
  if (opts && opts.note) toast(opts.note);
  dockSave();
}

// Open a chat in the dock by hand (a match's chat link, the pin buttons) and show it.
function dockOpen(room, label) {
  if (!room) return;
  if (chatRoomIsDone(room)) { toast('That match is complete, so its chat can only be read on the Chat tab.', true); return; }
  if (!_dock || _dock.tid !== tourneyId()) dockSync();
  if (!_dock) return;
  delete _dock.dismissed[room];
  if (!_dock.tabs.some(x => x.room === room)) _dock.tabs.push({ room, label: label || '', manual: 1 });
  dockSortTabs();
  _dock.active = room;
  _dock.collapsed = false;
  dockSave();
  dockRender();
  if (currentTab === 'chat') toast('Added to the chats on the right - they show when you leave the Chat tab');
}
function dockToggle(room, label) {
  if (_dock && _dock.tabs.some(x => x.room === room)) { dockRemove(room); dockRender(); }
  else dockOpen(room, label);
}

function dockUnmount() {
  const body = document.querySelector('#chatDock .cd-body');
  if (body) { destroyChatIn(body); body.innerHTML = ''; }
  _dockMounted = null;
}

// The dock is fixed to the viewport, below the sticky top bar. offsetHeight (not
// getBoundingClientRect) because body carries a `zoom` from the UI-scale setting.
function positionDock() {
  const bar = document.querySelector('.topbar');
  const h = (bar && bar.offsetHeight) ? bar.offsetHeight : 56;
  document.documentElement.style.setProperty('--pin-top', h + 'px');
}
window.addEventListener('resize', positionDock);

function dockRender() {
  if (!_dock) return;
  let el = document.getElementById('chatDock');
  if (currentTab === 'chat' || !_dock.tabs.length) {
    if (el) { dockUnmount(); el.remove(); }
    document.body.classList.remove('chat-docked', 'chat-dock-min');
    refreshPinButtons();
    return;
  }
  if (!el) {
    el = document.createElement('aside');
    el.id = 'chatDock';
    el.setAttribute('aria-label', 'Chats');
    el.innerHTML = '<button type="button" class="cd-launch"></button><div class="cd-head"></div><div class="cd-body"></div>';
    document.body.appendChild(el);
  }
  el.className = 'chat-dock' + (_dock.collapsed ? ' collapsed' : '');
  document.body.classList.toggle('chat-docked', !_dock.collapsed);
  document.body.classList.toggle('chat-dock-min', !!_dock.collapsed);
  positionDock();
  const isOrg = !!(T.viewer && T.viewer.organizer);
  const unread = room => (T.unreadByRoom && T.unreadByRoom[room]) || 0;
  const badgeOf = (room, active) => {
    const r = dockRoomInfo(room) || {};
    if (r.mention) return '<span class="cd-badge mention" title="You were mentioned">@</span>';
    if (isOrg && r.ping) return '<span class="cd-badge ping" title="Someone pinged the organizers">\u{1F514}</span>';
    const n = active ? 0 : unread(room);
    return n ? '<span class="cd-badge" title="' + n + ' unread">' + (n > 9 ? '9+' : n) + '</span>' : '';
  };
  // minimized: one button with everything waiting
  const waiting = _dock.tabs.reduce((s, x) => s + unread(x.room), 0);
  const flagged = _dock.tabs.some(x => { const r = dockRoomInfo(x.room) || {}; return r.mention || (isOrg && r.ping); });
  const launch = el.querySelector('.cd-launch');
  launch.innerHTML = '\u{1F4AC} Chats <span class="muted small">(' + _dock.tabs.length + ')</span>'
    + (flagged ? '<span class="cd-badge mention">!</span>' : (waiting ? '<span class="cd-badge">' + (waiting > 9 ? '9+' : waiting) + '</span>' : ''));
  launch.title = 'Show the chats';
  launch.onclick = () => { _dock.collapsed = false; dockSave(); dockRender(); };
  const head = el.querySelector('.cd-head');
  head.innerHTML = '<div class="cd-tabs" role="tablist">' + _dock.tabs.map(tab => {
    const on = tab.room === _dock.active;
    return `<div class="cd-tab${on ? ' on' : ''}" role="tab" tabindex="0" aria-selected="${on ? 'true' : 'false'}" data-cdroom="${esc(tab.room)}" title="${esc(dockRoomFull(tab.room, tab.label))}">`
      + `<span class="cd-tab-label">${esc(dockTabLabel(tab.room, tab.label))}</span>${badgeOf(tab.room, on)}`
      + `<button type="button" class="cd-x" data-cdclose="${esc(tab.room)}" title="Close this chat" aria-label="Close this chat">✕</button></div>`;
  }).join('') + '</div><button type="button" class="cd-min" title="Minimize the chats">Hide</button>';
  head.querySelectorAll('[data-cdroom]').forEach(tb => {
    const pick = () => { _dock.active = tb.dataset.cdroom; _dock.collapsed = false; dockSave(); dockRender(); };
    tb.onclick = (e) => { if (e.target.closest('[data-cdclose]')) return; pick(); };
    tb.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
  head.querySelectorAll('[data-cdclose]').forEach(b => b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    dockRemove(b.dataset.cdclose);
    dockRender();
  });
  head.querySelector('.cd-min').onclick = () => { _dock.collapsed = true; dockSave(); dockRender(); };
  // the chat itself: mounted only while shown, remounted only when the room changes
  const body = el.querySelector('.cd-body');
  if (_dock.collapsed || !_dock.active) dockUnmount();
  else if (_dockMounted !== _dock.active || !body.querySelector('.chat-panel')) {
    dockUnmount();
    _dockMounted = _dock.active;
    const tab = _dock.tabs.find(x => x.room === _dock.active) || {};
    mountChat(body, _dock.active, dockRoomFull(_dock.active, tab.label), { docked: true });
  }
  refreshPinButtons();
}

// Repaint every "open on the right" control from the dock's state. Cheap, and no caller has to
// remember which buttons it just drew.
function refreshPinButtons() {
  const open = new Set(_dock ? _dock.tabs.map(x => x.room) : []);
  document.querySelectorAll('[data-pinbtn]').forEach(b => {
    const room = b.dataset.pinbtn;
    if (!chatRoomPinnable(room)) { b.style.display = 'none'; return; }
    b.style.display = '';
    const on = open.has(room);
    b.classList.toggle('on', on);
    b.textContent = on ? '\u{1F4CC} Open on the right' : '\u{1F4CC} Keep open on the right';
    b.title = on ? 'This chat is in the chats on the right. Click to close it there.' : 'Keep this chat open in the chats on the right while you browse';
  });
  document.querySelectorAll('[data-pinroom]').forEach(b => {
    const room = b.dataset.pinroom;
    if (!chatRoomPinnable(room)) { b.style.display = 'none'; return; }
    b.style.display = '';
    const on = open.has(room);
    b.classList.toggle('on', on);
    b.title = on ? 'In the chats on the right - click to close it there' : 'Keep this chat open on the right';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
