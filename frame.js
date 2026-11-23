/*
 * Peace UI: a phone-friendly HUD for the Nitro game client.
 * Runs at document start inside the game frame (nitro.peacehotel.my), injected by PeaceUi.kt.
 *
 * - Draws its own tab bar, top bar, Friends and Me sheets in a shadow root.
 * - Reads friends, currencies, the user and the room from the game's WebSocket
 *   (packets are [int32 length][int16 header][body], unencrypted; strings are uint16 length + UTF-8).
 * - Opens Nitro's own windows (Navigator, Catalog, Inventory, Mentions, Phone...) by clicking
 *   Nitro's toolbar buttons, which nitro.css hides while this UI is on.
 * - Friend actions (follow, profile, message, accept) send the same packets Nitro sends.
 * - Talks to the app through window.PeaceUi (a web message listener limited to this origin).
 *
 * Selectors and packet ids are collected at the top so they are easy to adjust.
 */
(function () {
  'use strict';
  if (window.__peaceUi) return;
  window.__peaceUi = true;

  var assets = window.__peaceUiAssets || {};
  try { delete window.__peaceUiAssets; } catch (e) { window.__peaceUiAssets = undefined; }
  var BRIDGE = window.PeaceUi || null;

  // ---------------------------------------------------------------- config
  // Peace's own imager (the website uses it too), so custom clothes render.
  var IMAGER = 'https://imager.peacehotel.my/?figure=';
  var IN = {
    ROOM_ENTER: 758, ROOM_INFO: 687, DESKTOP_VIEW: 122,
    USER_INFO: 2725, USER_FIGURE: 2429,
    CREDITS: 3475, CURRENCY: 2018, ACTIVITY_POINTS: 2275,
    FRIENDS: 3130, FRIENDS_UPDATE: 2800, REQUESTS: 280, NEW_REQUEST: 2219, MESSENGER_CHAT: 1587,
    BATTLEPASS_DATA: 7212
  };
  var OUT = { FOLLOW: 3997, PROFILE: 3265, MESSENGER_CHAT: 3567, ACCEPT: 137, DECLINE: 2890 };
  // Nitro controls the tabs and Me tiles press. Each entry: selectors to try, in order.
  // Peace's client always renders its desktop toolbar (.nitro-toolbar) next to the phone tab bar, so the
  // first group is always in the page. The Me group lives in Nitro's Me menu (.nitro-toolbar-me), which
  // only exists while that menu is open.
  var NITRO = {
    rooms: ['.nitro-toolbar .navigation-item.icon-rooms', '.navigation-item.icon-rooms'],
    shop: ['.nitro-toolbar .navigation-item.icon-catalog', '.navigation-item.icon-catalog'],
    inventory: ['.nitro-toolbar .navigation-item.icon-inventory', '.navigation-item.icon-inventory'],
    mentions: ['.nitro-toolbar-right .navigation-item.icon-mention', '.navigation-item.icon-mention'],
    phone: ['.nitro-toolbar-right .navigation-item.icon-phone', '.navigation-item.icon-phone'],
    camera: ['.nitro-toolbar .navigation-item.icon-camera', '.navigation-item.icon-camera'],
    profile: ['.nitro-toolbar-me .icon-me-profile'],
    looks: ['.nitro-toolbar-me .icon-me-clothing'],
    achievements: ['.nitro-toolbar-me .icon-me-achievements'],
    prestige: ['.nitro-toolbar-me .icon-me-battlepass'],
    rares: ['.nitro-toolbar-me .icon-me-rarevalues']
  };
  // The avatar button that opens Nitro's Me menu. It has the "active" class while the menu is open.
  var NITRO_ME = ['.nitro-toolbar .navigation-item.item-avatar-bg-icon', '.navigation-item.item-avatar-bg-icon'];
  var DUCKETS = 0, DIAMONDS = 5;
  var FIGS_KEY = 'peaceUi.figs';
  // Currencies in Peace's order (ui-config system.currency.types). -1 = credits. Icons are Peace's own wallet icons.
  var WALLET = 'https://nitro.peacehotel.my/nitro-assets/images/wallet/';
  var CURRENCIES = [[-1, 'Credits'], [0, 'Duckets'], [5, 'Diamonds'], [103, 'Event points'], [130, 'Peace coins']];
  // Shown in the top pill (the rest are in the drop-down).
  var PILL = [-1, 0, 5];

  // ---------------------------------------------------------------- state
  var S = {
    me: { id: 0, name: '', figure: '', motto: '' },
    credits: null, cur: {},
    room: null, awaitingRoom: false,
    friends: {}, requests: [],
    conv: {}, unread: {},
    sheet: null, hmode: 'half', ff: 'online', q: '', chat: 0, card: 0,
    bp: { avail: null, unclaimed: 0 }
  };
  var sock = null;

  // ---------------------------------------------------------------- packets in
  var utf8 = new TextDecoder('utf-8');
  var enc = new TextEncoder();
  var WANT = {};
  Object.keys(IN).forEach(function (k) { WANT[IN[k]] = true; });

  function Reader(u, p, end) { this.u = u; this.dv = new DataView(u.buffer, u.byteOffset, u.byteLength); this.p = p; this.end = end; }
  Reader.prototype.need = function (n) { if (this.p + n > this.end) throw new Error('eof'); };
  Reader.prototype.int = function () { this.need(4); var v = this.dv.getInt32(this.p); this.p += 4; return v; };
  Reader.prototype.short = function () { this.need(2); var v = this.dv.getInt16(this.p); this.p += 2; return v; };
  Reader.prototype.bool = function () { this.need(1); var v = this.dv.getUint8(this.p) !== 0; this.p += 1; return v; };
  Reader.prototype.str = function () {
    this.need(2); var n = this.dv.getUint16(this.p); this.p += 2; this.need(n);
    var s = utf8.decode(this.u.subarray(this.p, this.p + n)); this.p += n; return s;
  };

  var carry = null, skip = 0;
  function feed(data) {
    if (!(data instanceof ArrayBuffer)) return;
    var u = new Uint8Array(data);
    if (skip > 0) {
      if (skip >= u.length) { skip -= u.length; return; }
      u = u.subarray(skip); skip = 0;
    }
    if (carry) {
      var joined = new Uint8Array(carry.length + u.length);
      joined.set(carry, 0); joined.set(u, carry.length);
      u = joined; carry = null;
    }
    var dv = new DataView(u.buffer, u.byteOffset, u.byteLength), p = 0;
    while (u.length - p >= 6) {
      var len = dv.getInt32(p);
      if (len < 2 || len > 67108864) return; // Out of sync; resume with the next frame.
      var head = dv.getInt16(p + 4), avail = u.length - p - 4;
      if (len > avail) {
        if (WANT[head]) carry = u.slice(p); else skip = len - avail;
        return;
      }
      if (WANT[head]) {
        try { onPacket(head, new Reader(u, p + 6, p + 4 + len)); } catch (e) { /* malformed or unexpected layout */ }
      }
      p += 4 + len;
    }
    if (p < u.length) carry = u.slice(p);
  }

  // The server sends a friend's look only while they are online, so remember the last one we saw.
  var figs = {};
  try { figs = JSON.parse(localStorage.getItem(FIGS_KEY) || '{}') || {}; } catch (e) { figs = {}; }
  var figsTimer = 0;
  function readFriend(r) {
    var f = { id: r.int(), name: r.str(), gender: r.int(), online: r.bool(), follow: r.bool(), figure: r.str(), cat: r.int(), motto: r.str() };
    try { r.str(); r.str(); r.bool(); r.bool(); r.bool(); f.rel = r.short(); } catch (e) { f.rel = 0; }
    if (f.figure) {
      if (figs[f.id] !== f.figure) {
        figs[f.id] = f.figure;
        clearTimeout(figsTimer);
        figsTimer = setTimeout(function () { try { localStorage.setItem(FIGS_KEY, JSON.stringify(figs)); } catch (e) {} }, 1000);
      }
    } else if (figs[f.id]) f.figure = figs[f.id];
    return f;
  }

  function onPacket(h, r) {
    switch (h) {
      case IN.USER_INFO:
        S.me.id = r.int(); S.me.name = r.str(); S.me.figure = r.str(); r.str(); S.me.motto = r.str();
        changed('me'); break;
      case IN.USER_FIGURE:
        S.me.figure = r.str(); changed('me'); break;
      case IN.CREDITS:
        S.credits = Math.floor(parseFloat(r.str()) || 0); changed('money'); break;
      case IN.CURRENCY:
        for (var n = r.int(); n > 0; n--) { var t = r.int(); S.cur[t] = r.int(); }
        changed('money'); break;
      case IN.BATTLEPASS_DATA:
        S.bp.avail = r.bool(); changed('me'); break;
      case IN.ACTIVITY_POINTS:
        var amount = r.int(); r.int(); S.cur[r.int()] = amount; changed('money'); break;
      case IN.FRIENDS:
        r.int(); var index = r.int();
        if (index === 0) S.friends = {};
        for (var c = r.int(); c > 0; c--) { var f = readFriend(r); S.friends[f.id] = f; }
        changed('friends'); break;
      case IN.FRIENDS_UPDATE:
        for (var k = r.int(); k > 0; k--) { r.int(); r.str(); }
        for (var u = r.int(); u > 0; u--) {
          var type = r.int();
          if (type === -1) delete S.friends[r.int()];
          else { var g = readFriend(r); S.friends[g.id] = g; }
        }
        changed('friends'); break;
      case IN.REQUESTS:
        r.int(); S.requests = [];
        for (var q = r.int(); q > 0; q--) S.requests.push({ id: r.int(), name: r.str(), figure: r.str() });
        changed('friends'); break;
      case IN.NEW_REQUEST:
        var req = { id: r.int(), name: r.str(), figure: r.str() };
        S.requests = S.requests.filter(function (x) { return x.id !== req.id; }).concat(req);
        changed('friends'); break;
      case IN.MESSENGER_CHAT:
        var from = r.int(), text = r.str(), secs = 0;
        try { secs = r.int(); } catch (e) {}
        addMsg(from, false, text, Date.now() - secs * 1000);
        if (S.chat !== from || !pageOpen()) S.unread[from] = (S.unread[from] || 0) + 1;
        changed('chat'); break;
      case IN.ROOM_ENTER:
        S.awaitingRoom = true; break;
      case IN.ROOM_INFO:
        var enter = r.bool(), rid = r.int(), name = r.str(), info = { id: rid, name: name.trim() };
        try { r.int(); info.owner = r.str(); r.int(); info.users = r.int(); info.max = r.int(); } catch (e) {}
        if (info.name && (enter || S.awaitingRoom || (S.room && S.room.id === rid))) {
          S.room = info; S.awaitingRoom = false; changed('room');
        }
        break;
      case IN.DESKTOP_VIEW:
        S.room = null; changed('room'); break;
    }
  }

  // ---------------------------------------------------------------- packets out
  function send(header, args) {
    if (!sock || sock.readyState !== 1) { toast('Not connected to the hotel'); return false; }
    var parts = [], size = 2;
    args.forEach(function (a) {
      if (typeof a === 'string') { var b = enc.encode(a); parts.push(b); size += 2 + b.length; }
      else if (typeof a === 'boolean') { parts.push(a); size += 1; }
      else { parts.push(a | 0); size += 4; }
    });
    var buf = new ArrayBuffer(4 + size), dv = new DataView(buf), u = new Uint8Array(buf), p = 6;
    dv.setInt32(0, size); dv.setInt16(4, header);
    parts.forEach(function (a) {
      if (a instanceof Uint8Array) { dv.setUint16(p, a.length); u.set(a, p + 2); p += 2 + a.length; }
      else if (typeof a === 'boolean') { dv.setUint8(p, a ? 1 : 0); p += 1; }
      else { dv.setInt32(p, a); p += 4; }
    });
    try { sock.send(buf); return true; } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- WebSocket hook
  try {
    var NativeWs = window.WebSocket;
    if (NativeWs) {
      var PeaceWs = function (url, protocols) {
        var ws = protocols === undefined ? new NativeWs(url) : new NativeWs(url, protocols);
        sock = ws; carry = null; skip = 0;
        ws.addEventListener('message', function (e) {
          try { feed(e.data); } catch (err) { carry = null; skip = 0; }
        });
        ws.addEventListener('close', function () { if (sock === ws) sock = null; });
        return ws;
      };
      PeaceWs.prototype = NativeWs.prototype;
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { PeaceWs[k] = NativeWs[k]; });
      window.WebSocket = PeaceWs;
    }
  } catch (e) {}

  // ---------------------------------------------------------------- chat history (kept on this device)
  var CONV_KEY = 'peaceUi.conv';
  try { S.conv = JSON.parse(localStorage.getItem(CONV_KEY) || '{}') || {}; } catch (e) { S.conv = {}; }
  var saveTimer = 0;
  function addMsg(id, mine, text, at) {
    var list = S.conv[id] || (S.conv[id] = []);
    list.push([mine ? 1 : 0, text, at]);
    if (list.length > 100) list.splice(0, list.length - 100);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var ids = Object.keys(S.conv).sort(function (a, b) { return lastAt(b) - lastAt(a); }).slice(0, 40), keep = {};
      ids.forEach(function (i) { keep[i] = S.conv[i]; });
      try { localStorage.setItem(CONV_KEY, JSON.stringify(keep)); } catch (e) {}
    }, 800);
  }
  function lastAt(id) { var l = S.conv[id]; return l && l.length ? l[l.length - 1][2] : 0; }

  // ---------------------------------------------------------------- Nitro controls
  function findNitro(key) {
    var list = NITRO[key] || [];
    for (var i = 0; i < list.length; i++) { var el = document.querySelector(list[i]); if (el) return el; }
    return null;
  }
  function meToggle() {
    for (var i = 0; i < NITRO_ME.length; i++) { var el = document.querySelector(NITRO_ME[i]); if (el) return el; }
    return null;
  }
  function pressNitro(key) {
    var el = findNitro(key);
    if (el) { el.click(); return Promise.resolve(true); }
    // A Me menu control: open Nitro's Me menu, press the control, and make sure the menu ends up closed.
    // The menu fades out (still in the page for a moment), so check the toggle's "active" class, not the menu.
    var toggle = meToggle();
    if (!toggle || !/^(profile|looks|achievements|prestige|rares)$/.test(key)) return Promise.resolve(false);
    var wasOpen = toggle.classList.contains('active');
    if (!wasOpen) toggle.click();
    function closeMenu() { var t = meToggle(); if (t && t.classList.contains('active')) t.click(); }
    return new Promise(function (resolve) {
      var tries = 0;
      (function poll() {
        var el2 = findNitro(key);
        if (el2) {
          el2.click();
          setTimeout(closeMenu, 60);
          resolve(true);
        } else if (++tries < 12) setTimeout(poll, 50);
        else { closeMenu(); resolve(false); }
      })();
    });
  }
  // Room tools (zoom, chat history, bubbles, like, room settings, voice). On phones Peace only renders them
  // inside its More sheet (#hud-more-room), which this UI hides. The sheet stays open until its own tab is
  // pressed again, so it is opened (still hidden) while the Room menu is open and the tools are pressed there.
  var RT = [
    ['zoom', '.icon-zoom-more,.icon-zoom-less'], ['history', '.icon-chat-history'],
    ['bubbles', '.icon-chat-enablebubble,.icon-chat-disablebubble'], ['like', '.icon-like-room'],
    ['voice', '.voice-room-button'], ['youtube', '.icon-youtube-rt'], ['builder', '.icon-buildertools-rt'],
    ['settings', '.nitro-room-tools-settings']
  ];
  function moreTab() {
    var tabs = document.querySelectorAll('.nitro-hud-tabbar .hud-tab');
    return tabs.length ? tabs[tabs.length - 1] : null;
  }
  function roomTools() { var el = document.getElementById('hud-more-room'); return el && el.querySelector('.nitro-room-tools') ? el : null; }
  function openRoomTools() {
    if (roomTools()) return Promise.resolve(roomTools());
    var hidden = document.querySelector('.nitro-hud-tabs-toggle.is-hidden');
    if (hidden) hidden.click();
    return new Promise(function (resolve) {
      var tries = 0, pressed = false;
      (function poll() {
        var el = roomTools();
        if (el) return resolve(el);
        var t = moreTab();
        if (t && !pressed && !t.classList.contains('active')) { t.click(); pressed = true; }
        if (++tries < 16) setTimeout(poll, 50); else resolve(null);
      })();
    });
  }
  function closeRoomTools() { var t = moreTab(); if (t && t.classList.contains('active')) t.click(); }
  function rtFind(key) {
    var box = roomTools(), def = RT.find(function (x) { return x[0] === key; });
    return box && def ? box.querySelector(def[1]) : null;
  }

  function openNitro(key, label) {
    closeAll();
    pressNitro(key).then(function (ok) { if (!ok) toast(label + ' is not available here yet'); });
  }

  // ---------------------------------------------------------------- dark Nitro windows
  // Nitro's windows are drawn for a light theme. Instead of a rule for every window, elements are
  // marked by their computed colours: near-black text turns light, light neutral backgrounds turn into
  // dark surfaces, light pastel backgrounds keep a faint tint, light borders turn subtle. nitro.css
  // styles the marks. They are data attributes, which React leaves alone when it re-renders.
  var darkSeen = new WeakSet(), darkQueued = false, darkObserver = null;
  var DARK_SKIP = 'img,canvas,svg,path,.chat-content,.chat-bubble,.avatar-image,.nitro-card-header,.nitro-card-tabs,.phone-window,.phone-outer';
  function rgba(s) {
    var m = s && s.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
  }
  function lum(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }
  function sat(c) { var mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); return mx ? (mx - mn) / mx : 0; }
  function ownText(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }
  function darkMark(el) {
    if (darkSeen.has(el)) return;
    darkSeen.add(el);
    if (el.closest(DARK_SKIP)) return;
    var cs = getComputedStyle(el);
    if (ownText(el) || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      var c = rgba(cs.color);
      if (c && c.a > 0.4) {
        var L = lum(c);
        if (L < 0.3) el.setAttribute('data-pu-ink', sat(c) > 0.35 ? 'tint' : '1');
        else if (L < 0.5 && sat(c) < 0.2) el.setAttribute('data-pu-ink', '2');
      }
    }
    // Flat colours and CSS gradients count; pictures never do. Inline colours are content (colour swatches).
    var bi = cs.backgroundImage;
    if ((bi === 'none' || (bi.indexOf('gradient') >= 0 && bi.indexOf('url(') < 0)) && !el.style.backgroundColor && !el.style.background) {
      var b = rgba(bi === 'none' ? cs.backgroundColor : bi);
      if (b && b.a > 0.5 && lum(b) > 0.7) {
        if (sat(b) > 0.12) { el.style.setProperty('--pu-tint', 'rgb(' + b.r + ',' + b.g + ',' + b.b + ')'); el.setAttribute('data-pu-bg', 'tint'); }
        else el.setAttribute('data-pu-bg', el.parentElement && el.parentElement.closest('[data-pu-bg]') ? '2' : '1');
      }
    }
    var bd = rgba(cs.borderTopColor);
    if (bd && parseFloat(cs.borderTopWidth) > 0 && lum(bd) > 0.55) el.setAttribute('data-pu-bd', '1');
  }
  function darkScan() {
    darkQueued = false;
    // Whole card: some windows (chat history) don't use .content-area. Header and tabs are in DARK_SKIP.
    var areas = document.querySelectorAll('.draggable-window .nitro-card');
    for (var i = 0; i < areas.length; i++) {
      var all = areas[i].getElementsByTagName('*');
      for (var j = 0; j < all.length; j++) darkMark(all[j]);
    }
    shopSync();
  }
  // ---------------------------------------------------------------- full-screen Shop
  // On a phone the Shop shows one pane at a time: the category list, then the chosen page with a back
  // bar. nitro.css does the layout; this only switches .pu-page on the card and keeps the back bar there.
  var shopSeen = new WeakSet();
  function shopSync() {
    var card = document.querySelector('.nitro-catalog');
    if (!card) return;
    if (!shopSeen.has(card)) { shopSeen.add(card); card.classList.remove('pu-page'); }
    var col = card.querySelector('.catalog-left + .g-col-8');
    if (!col) return;
    var bar = col.querySelector(':scope > .pu-back');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'pu-back'; bar.setAttribute('role', 'button');
      bar.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg><span></span>';
      col.insertBefore(bar, col.firstChild);
    }
    var act = card.querySelector('.nitro-catalog-navigation-grid-container .layout-grid-item.active');
    bar.querySelector('span').textContent = act ? act.textContent.trim() : 'Categories';
  }
  function shopClick(e) {
    var t = e.target, card = t.closest && t.closest('.nitro-catalog');
    if (!card) return;
    if (t.closest('.pu-back') || t.closest('.nitro-card-tabs .nav-link')) { card.classList.remove('pu-page'); return; }
    var item = t.closest('.nitro-catalog-navigation-grid-container .layout-grid-item');
    // A branch (it has an arrow) only opens its children; a page opens full width.
    if (item && !item.querySelector('svg')) setTimeout(function () { card.classList.add('pu-page'); shopSync(); }, 0);
  }

  function darkQueue() { if (!darkQueued) { darkQueued = true; setTimeout(darkScan, 120); } }
  function setDark(on) {
    document.documentElement.classList.toggle('pu-dark', on);
    if (on && !darkObserver) {
      darkObserver = new MutationObserver(function (ms) {
        if (darkQueued) return;
        for (var i = 0; i < ms.length; i++) {
          var t = ms[i].target;
          if (t.nodeType === 1 && t.closest('.draggable-window')) { darkQueue(); return; }
          var add = ms[i].addedNodes;
          for (var k = 0; k < add.length; k++) {
            var n = add[k];
            if (n.nodeType === 1 && (n.matches('.draggable-window,.nitro-card') || n.querySelector('.nitro-card'))) { darkQueue(); return; }
          }
        }
      });
      darkObserver.observe(document.body, { childList: true, subtree: true });
      darkQueue();
    } else if (!on && darkObserver) {
      darkObserver.disconnect(); darkObserver = null;
    }
  }

  // ---------------------------------------------------------------- helpers
  var P = {
    search: '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevl: '<path d="m15 18-6-6 6-6"/>', chevr: '<path d="m9 18 6-6-6-6"/>', chevd: '<path d="m6 9 6 6 6-6"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    follow: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5M15 12H3"/>',
    compass: '<circle cx="12" cy="12" r="9.5"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3Z"/>',
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
    smile: '<circle cx="12" cy="12" r="9.5"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>',
    skull: '<path d="M16 20a2 2 0 0 0 1.6-3.2 8 8 0 1 0-11.2 0A2 2 0 0 0 8 20Z"/><path d="M8 20v2h8v-2"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>',
    shirt: '<path d="M20.4 3.5 16 2a4 4 0 0 1-8 0L3.6 3.5a2 2 0 0 0-1.3 2.2l.6 3.5a1 1 0 0 0 1 .8H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.2a1 1 0 0 0 1-.8l.6-3.5a2 2 0 0 0-1.4-2.2Z"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M11 18h2"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.5 1-1 1.2C7.9 18.8 7 20.2 7 22M14 14.7V17c0 .6.5 1 1 1.2 1.1.6 2 2 2 3.8"/><path d="M18 2H6v7a6 6 0 0 0 12 0Z"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/>',
    home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h6M16 13H8M16 17H8M10 9H8"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    gem: '<path d="M6 3h12l4 6-10 12L2 9Z"/><path d="M2 9h20M12 21 8 9l4-6 4 6-4 12"/>',
    zoomin: '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2M11 8v6M8 11h6"/>',
    zoomout: '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2M8 11h6"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    bubble: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
    bubbleoff: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="m3 3 18 18"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
    play: '<rect x="2" y="4" width="20" height="16" rx="4"/><path d="m10 9 5 3-5 3Z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    star: '<path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9Z"/>'
  };
  function ic(n, z) { return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"' + (z ? ' style="width:' + z + 'px;height:' + z + 'px"' : '') + '>' + (P[n] || '') + '</svg>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return (n || 0).toLocaleString('en-US'); }
  function short(n) { if (n == null) return '…'; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : num(n); }
  function hhmm(t) { var d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function av(name, figure, size) {
    var cls = 'av' + (size ? ' ' + size : '');
    var ini = '<span class="' + cls + ' ini" style="--h:' + hue(name || '?') + '">' + esc((name || '?').charAt(0).toUpperCase()) + '</span>';
    if (!figure || !IMAGER) return ini;
    var src = IMAGER + encodeURIComponent(figure) + '&direction=2&head_direction=2&gesture=sml';
    return '<span class="' + cls + '" data-ini="' + esc(name || '?') + '"><img src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></span>';
  }
  function avw(f, size) { return '<span class="avw">' + av(f.name, f.figure, size) + (f.online ? '<i class="st"></i>' : '') + '</span>'; }
  var REL = { 1: ['heart', '#f472b6', 'Heart', 1], 2: ['smile', '#facc15', 'Smile', 0], 3: ['skull', '#a1a1aa', 'Bobba', 0] };
  function rel(r) { var x = REL[r]; return x ? '<span class="rl' + (x[3] ? ' fill' : '') + '" style="--c:' + x[1] + '" title="' + x[2] + '">' + ic(x[0]) + '</span>' : ''; }

  function friendList() { return Object.keys(S.friends).map(function (k) { return S.friends[k]; }); }
  function byName(a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; }
  function sortFriends(a, b) {
    return ((S.unread[b.id] || 0) - (S.unread[a.id] || 0)) || ((b.rel === 1) - (a.rel === 1)) || byName(a, b);
  }
  function unreadTotal() { var t = 0; Object.keys(S.unread).forEach(function (k) { t += S.unread[k]; }); return t; }
  function nameOf(id) { var f = S.friends[id]; return f ? f.name : 'User ' + id; }

  // ---------------------------------------------------------------- DOM
  var host, root, $tabs, $sheet, $shc, $page, $modal, $card, $toast, $pop, $rpop, $chip, $money;
  function $(sel) { return root.querySelector(sel); }

  function mount() {
    if (host || !document.body) return;
    host = document.createElement('div');
    host.id = 'peace-ui';
    root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = assets.ui || '';
    root.appendChild(style);
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<div class="top"><button class="pill roomchip" data-a="room" hidden><span class="nm"></span><span class="ct">' + ic('user', 14) + '<b></b></span>' + ic('chevd', 16) + '</button>' +
      '<button class="pill money" data-a="money" id="crk"></button></div>' +
      '<div class="pop" id="pop"></div>' +
      '<div class="pop rpop" id="rpop"></div>' +
      '<div class="sheet" id="sheet"><div class="grab" id="grab"><i></i></div><div class="shc" id="shc"></div></div>' +
      '<nav class="tabs" id="tabs">' +
      tab('rooms', 'compass', 'Rooms') + tab('shop', 'bag', 'Shop') + tab('friends', 'users', 'Friends', 'fbadge') + tab('inventory', 'box', 'Inventory') +
      '<button class="tab" data-tab="me"><span class="ico"><span class="mehead" id="mehead">' + ic('user', 18) + '</span><i class="rdot" id="medot" hidden></i></span><span>Me</span></button>' +
      '</nav>' +
      '<div class="page" id="page"></div>' +
      '<div class="modal" id="modal"><div class="scrim" data-a="cclose"></div><div class="card" id="card"></div></div>' +
      '<div class="toast" id="toast" role="status"></div>';
    while (wrap.firstChild) root.appendChild(wrap.firstChild);
    document.body.appendChild(host);

    $tabs = $('#tabs'); $sheet = $('#sheet'); $shc = $('#shc'); $page = $('#page'); $modal = $('#modal'); $card = $('#card');
    $toast = $('#toast'); $pop = $('#pop'); $rpop = $('#rpop'); $chip = $('.roomchip'); $money = $('#crk');

    var nitroStyle = document.createElement('style');
    nitroStyle.id = 'peace-ui-nitro';
    nitroStyle.textContent = assets.nitro || '';
    (document.head || document.documentElement).appendChild(nitroStyle);
    document.documentElement.classList.add('pu-on');
    setDark(true);
    bind();
    renderAll();
    post({ a: 'ready' });
  }
  function tab(id, icon, label, badge) {
    return '<button class="tab" data-tab="' + id + '"><span class="ico">' + ic(icon, 22) + (badge ? '<b class="badge" id="' + badge + '" hidden></b>' : '') + '</span><span>' + label + '</span></button>';
  }

  // ---------------------------------------------------------------- rendering
  var dirty = {};
  var flushQueued = false;
  function changed(what) {
    dirty[what] = true;
    if (flushQueued || !root) return;
    flushQueued = true;
    requestAnimationFrame(flush);
  }
  function flush() {
    flushQueued = false;
    var d = dirty; dirty = {};
    if (d.money || d.me) renderTop();
    if (d.room) renderTop();
    if (d.me || d.bp) renderMeTab();
    if (d.friends || d.chat) renderBadges();
    if (S.sheet === 'friends' && (d.friends || d.chat)) rerenderSheet();
    if (S.sheet === 'me' && (d.me || d.money || d.bp)) rerenderSheet();
    if (pageOpen() && d.chat) renderChat(true);
    if ($modal.classList.contains('on') && S.card && d.friends) renderCard();
  }
  function renderAll() { renderTop(); renderMeTab(); renderBadges(); }

  function renderTop() {
    if (S.room) {
      $chip.hidden = false;
      $chip.querySelector('.nm').textContent = S.room.name;
      var ct = $chip.querySelector('.ct');
      ct.hidden = S.room.users == null;
      ct.querySelector('b').textContent = S.room.users == null ? '' : S.room.users;
    } else { $chip.hidden = true; if ($rpop.classList.contains('on')) closeRoomMenu(); }
    $money.innerHTML = PILL.filter(function (t) { return t === -1 || amount(t) != null; }).map(function (t) {
      return '<span class="cy">' + cicon(t) + '<b>' + short(amount(t)) + '</b></span>';
    }).join('') + ic('chevd', 16);
    if ($pop.classList.contains('on')) renderPop();
  }
  function amount(t) { return t === -1 ? S.credits : S.cur[t]; }
  function cicon(t) { return '<img class="ci" src="' + WALLET + t + '.png" alt="" referrerpolicy="no-referrer">'; }
  function renderPop() {
    $pop.innerHTML = CURRENCIES.filter(function (c) { return c[0] === -1 || amount(c[0]) != null; }).map(function (c) {
      var v = amount(c[0]);
      return '<div class="pr">' + cicon(c[0]) + c[1] + '<b>' + (v == null ? '…' : num(v)) + '</b></div>';
    }).join('');
  }

  // Room menu: the room's own tools, pressed inside Peace's hidden More sheet.
  var RT_UI = {
    zoom: function (el) { return el.querySelector('.icon-zoom-more') || el.classList.contains('icon-zoom-more') ? ['zoomin', 'Zoom in'] : ['zoomout', 'Zoom out']; },
    history: function () { return ['history', 'Chat history']; },
    bubbles: function (el) { return el.classList.contains('icon-chat-disablebubble') ? ['bubble', 'Show bubbles'] : ['bubbleoff', 'Hide bubbles']; },
    like: function () { return ['heart', 'Like room']; },
    voice: function (el) { return ['mic', el.classList.contains('is-live') ? 'Voice (live)' : 'Room voice']; },
    youtube: function () { return ['play', 'YouTube']; },
    builder: function () { return ['grid', 'Builder tools']; },
    settings: function () { return ['cog', 'Room settings']; }
  };
  function openRoomMenu() {
    $pop.classList.remove('on');
    $rpop.innerHTML = '<div class="rhead"><b>' + esc(S.room ? S.room.name : 'Room') + '</b></div><div class="empty sm">Loading room tools…</div>';
    $rpop.classList.add('on'); report();
    openRoomTools().then(function () { if ($rpop.classList.contains('on')) renderRoomMenu(); });
  }
  function closeRoomMenu() {
    if (!$rpop.classList.contains('on')) return;
    $rpop.classList.remove('on'); closeRoomTools(); report();
  }
  function renderRoomMenu() {
    var box = roomTools();
    var name = box && box.querySelector('.rt-room-name'), owner = box && box.querySelector('.rt-room-name + * .mb-1');
    var head = '<div class="rhead"><b>' + esc(name ? name.textContent : (S.room ? S.room.name : 'Room')) + '</b>' + (owner ? '<small>' + esc(owner.textContent) + '</small>' : '') + '</div>';
    if (!box) { $rpop.innerHTML = head + '<div class="empty sm">Room tools are not available here</div>'; return; }
    var btns = RT.map(function (d) {
      var el = box.querySelector(d[1]); if (!el) return '';
      var u = RT_UI[d[0]](el);
      return '<button class="rt" data-rt="' + d[0] + '">' + ic(u[0], 22) + '<span>' + u[1] + '</span></button>';
    }).join('');
    $rpop.innerHTML = head + '<div class="rts">' + btns + '</div>' +
      '<button class="li" data-a="rooms">' + ic('compass') + '<span class="lt">Browse rooms</span><span class="end">' + ic('chevr', 18) + '</span></button>';
  }
  function pressRoomTool(key) {
    openRoomTools().then(function () {
      var el = rtFind(key);
      if (!el) { toast('Not available in this room'); return; }
      el.click();
      if (key === 'zoom' || key === 'bubbles' || key === 'voice') setTimeout(renderRoomMenu, 120);
      else { closeRoomMenu(); }
    });
  }
  function renderMeTab() {
    var el = $('#mehead');
    el.innerHTML = S.me.figure && IMAGER ? '<img src="' + esc(IMAGER + encodeURIComponent(S.me.figure) + '&direction=2&head_direction=2') + '" alt="" referrerpolicy="no-referrer">' : ic('user', 18);
    var dot = $('#medot'); if (dot) dot.hidden = !(S.bp.avail && S.bp.unclaimed > 0);
  }
  function renderBadges() {
    var n = unreadTotal() + S.requests.length, b = $('#fbadge');
    b.textContent = n; b.hidden = !n;
  }
  function setTabs() {
    root.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === S.sheet); });
  }

  // ---------------------------------------------------------------- sheets
  var SHEETS = {
    friends: { html: friendsHTML, after: function () { var i = $('#fq'); if (i) i.value = S.q; } },
    me: { html: meHTML }
  };
  function openSheet(k, mode) {
    closeModal(); closePage(); $pop.classList.remove('on');
    S.sheet = k;
    $shc.innerHTML = SHEETS[k].html();
    if (SHEETS[k].after) SHEETS[k].after();
    $sheet.classList.add('open');
    setTabs();
    setH(mode || 'half');
    report();
  }
  function rerenderSheet() {
    if (!S.sheet) return;
    var b = $shc.querySelector('.sbody'), y = b ? b.scrollTop : 0;
    var focused = root.activeElement && root.activeElement.id === 'fq';
    if (focused) { renderFriendBody(); return; }
    $shc.innerHTML = SHEETS[S.sheet].html();
    if (SHEETS[S.sheet].after) SHEETS[S.sheet].after();
    var nb = $shc.querySelector('.sbody'); if (nb) nb.scrollTop = y;
  }
  function closeSheet() {
    if (!S.sheet) return;
    S.sheet = null;
    $sheet.classList.remove('open');
    $sheet.style.height = '0px';
    setTabs();
    report();
  }
  function heights() {
    var h = host.clientHeight - $tabs.offsetHeight;
    return { half: Math.round(h * 0.58), full: h - 8 };
  }
  function setH(mode) { S.hmode = mode; $sheet.style.height = heights()[mode] + 'px'; }

  // drag the sheet by its handle or header
  var drag = null;
  function dragStart(e) {
    if (!S.sheet || e.target.closest('button, input')) return;
    if (!e.target.closest('#grab, .shead')) return;
    drag = { y: e.clientY, h: $sheet.offsetHeight, id: e.pointerId };
    $sheet.classList.add('drag');
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function dragMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var hs = heights(), h = Math.max(0, Math.min(hs.full, drag.h + drag.y - e.clientY));
    $sheet.style.height = h + 'px';
  }
  function dragEnd(e) {
    if (!drag || e.pointerId !== drag.id) return;
    $sheet.classList.remove('drag');
    var hs = heights(), h = $sheet.offsetHeight, moved = Math.abs(e.clientY - drag.y);
    drag = null;
    if (moved < 6) { setH(S.hmode === 'half' ? 'full' : 'half'); return; }
    if (h < hs.half * 0.55) closeSheet();
    else setH(Math.abs(h - hs.half) < Math.abs(h - hs.full) ? 'half' : 'full');
  }

  // ---------------------------------------------------------------- Friends
  function chipRow(items) {
    return '<div class="chips" id="fchips">' + items.map(function (c) {
      return '<button class="chip' + (S.ff === c[0] ? ' on' : '') + '" data-ff="' + c[0] + '">' + c[1] + '<span class="n">' + c[2] + '</span>' + (c[3] ? '<i class="rd"></i>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function friendsHTML() {
    var all = friendList(), on = all.filter(function (f) { return f.online; }).length;
    var chats = Object.keys(S.conv).filter(function (k) { return S.conv[k].length; }).length;
    return '<div class="shead"><div class="tt"><h3>Friends</h3><div class="sub"><i class="sdot"></i>' + on + ' online · ' + all.length + ' friends</div></div></div>' +
      '<label class="search">' + ic('search', 18) + '<input id="fq" type="search" placeholder="Search ' + all.length + ' friends" autocomplete="off" enterkeyhint="search"><button class="clr" data-a="fclr" aria-label="Clear search"' + (S.q ? '' : ' hidden') + '>' + ic('x', 16) + '</button></label>' +
      chipRow([['online', 'Online', on], ['all', 'All', all.length], ['chats', 'Chats', chats, unreadTotal() > 0], ['req', 'Requests', S.requests.length, S.requests.length > 0]]) +
      '<div class="sbody" id="fbody">' + friendBody() + '</div>';
  }
  function renderFriendBody() { var b = $('#fbody'); if (b) b.innerHTML = friendBody(); var c = root.querySelector('[data-a=fclr]'); if (c) c.hidden = !S.q; }
  function friendRow(f) {
    var u = S.unread[f.id] || 0;
    return '<div class="row' + (f.online ? '' : ' off') + (u ? ' unread' : '') + '" data-f="' + f.id + '" role="button" tabindex="0">' + avw(f) +
      '<span class="who"><span class="nm"><span>' + esc(f.name) + '</span>' + rel(f.rel) + '</span><span class="mt">' + esc(f.motto || (f.online ? 'Online' : 'Offline')) + '</span></span>' +
      '<span class="acts">' + (f.online ? '<button class="act" data-follow="' + f.id + '" aria-label="Go to ' + esc(f.name) + '"' + (f.follow ? '' : ' disabled') + '>' + ic('follow') + '</button>' : '') +
      '<button class="act" data-chat="' + f.id + '" aria-label="Message ' + esc(f.name) + '">' + ic('msg') + (u ? '<b class="badge">' + u + '</b>' : '') + '</button></span></div>';
  }
  function friendBody() {
    var q = S.q.trim().toLowerCase(), list = friendList();
    var match = function (f) { return !q || f.name.toLowerCase().indexOf(q) >= 0 || (f.motto || '').toLowerCase().indexOf(q) >= 0; };
    if (!list.length && S.ff !== 'req') return '<div class="empty"><p>Friends appear here once the hotel has loaded.</p></div>';
    if (S.ff === 'req') {
      if (!S.requests.length) return '<div class="empty"><p>No friend requests.</p></div>';
      return '<div class="sec"><span>Friend requests</span><button class="link" data-a="accall">Accept all</button></div>' + S.requests.map(function (r) {
        return '<div class="row">' + avw({ name: r.name, figure: r.figure }) + '<span class="who"><span class="nm"><span>' + esc(r.name) + '</span></span></span><span class="acts"><button class="btn pri sm" data-acc="' + r.id + '">Accept</button><button class="act" data-dec="' + r.id + '" aria-label="Decline">' + ic('x', 18) + '</button></span></div>';
      }).join('');
    }
    if (S.ff === 'chats') {
      var ids = Object.keys(S.conv).filter(function (k) { return S.conv[k].length; }).sort(function (a, b) { return lastAt(b) - lastAt(a); });
      ids = ids.filter(function (id) { return !q || nameOf(id).toLowerCase().indexOf(q) >= 0; });
      if (!ids.length) return '<div class="empty"><p>No chats yet. Tap the message button next to a friend.</p></div>';
      return ids.map(function (id) {
        var f = S.friends[id] || { id: id, name: nameOf(id) }, l = S.conv[id][S.conv[id].length - 1], u = S.unread[id] || 0;
        return '<div class="row' + (u ? ' unread' : '') + '" data-chat="' + id + '" role="button" tabindex="0">' + avw(f) +
          '<span class="who"><span class="nm"><span>' + esc(f.name) + '</span><time>' + hhmm(l[2]) + '</time></span><span class="mt">' + (l[0] ? 'You: ' : '') + esc(l[1]) + '</span></span>' + (u ? '<span class="cnt">' + u + '</span>' : '') + '</div>';
      }).join('');
    }
    var online = list.filter(function (f) { return f.online && match(f); }).sort(sortFriends);
    var h = '';
    if (online.length) h += '<div class="sec"><span>Online</span><span>' + online.length + '</span></div>' + online.map(friendRow).join('');
    if (S.ff === 'all') {
      var off = list.filter(function (f) { return !f.online && match(f); }).sort(sortFriends);
      if (off.length) h += '<div class="sec"><span>Offline</span><span>' + off.length + '</span></div>' + off.map(friendRow).join('');
    }
    if (!h) h = q ? '<div class="empty"><p>No friends match “' + esc(S.q) + '”.</p></div>' : '<div class="empty"><p>No friends online right now.</p><button class="btn sec" data-ff="all">Show all friends</button></div>';
    return h;
  }

  // friend card
  function openCard(id) { S.card = +id; renderCard(); $modal.classList.add('on'); report(); }
  function renderCard() {
    var f = S.friends[S.card];
    if (!f) { closeModal(); return; }
    $card.innerHTML = '<div class="grab"><i></i></div><div class="hero">' + avw(f, 'xl') + '<div class="tt"><h4>' + esc(f.name) + rel(f.rel) + '</h4><div class="sub">' + (f.online ? '<i class="sdot"></i>Online' : '<i class="sdot off"></i>Offline') + '</div></div><button class="ghost" data-a="cclose" aria-label="Close">' + ic('x') + '</button></div>' +
      (f.motto ? '<div class="motto">' + esc(f.motto) + '</div>' : '') +
      '<div class="trio"><button class="pri" data-chat="' + f.id + '">' + ic('msg') + 'Message</button><button data-follow="' + f.id + '"' + (f.online && f.follow ? '' : ' disabled') + '>' + ic('follow') + 'Go to</button><button data-prof="' + f.id + '">' + ic('user') + 'Profile</button></div>';
  }
  function closeModal() { if (!$modal.classList.contains('on')) return; $modal.classList.remove('on'); S.card = 0; report(); }

  // ---------------------------------------------------------------- Messages page
  function pageOpen() { return $page && $page.classList.contains('on'); }
  function openChat(id) {
    id = +id; closeModal();
    S.chat = id; S.unread[id] = 0;
    S.conv[id] = S.conv[id] || [];
    var f = S.friends[id] || { id: id, name: nameOf(id) };
    $page.innerHTML = '<header class="phead"><button class="ibtn" data-a="back" aria-label="Back">' + ic('chevl') + '</button>' + avw(f) +
      '<div class="tt"><h3>' + esc(f.name) + '</h3><div class="sub">' + (f.online ? 'Online' : 'Offline') + '</div></div>' +
      '<button class="ghost" data-follow="' + id + '" aria-label="Go to ' + esc(f.name) + '"' + (f.online && f.follow ? '' : ' disabled') + '>' + ic('follow') + '</button></header>' +
      '<div class="msgs" id="msgs"></div>' +
      '<form class="compose" id="compose"><label class="field"><input id="cin" type="text" placeholder="Message ' + esc(f.name) + '" autocomplete="off" enterkeyhint="send" maxlength="255"></label><button class="send" type="submit" aria-label="Send">' + ic('send') + '</button></form>';
    $page.classList.add('on');
    renderChat();
    renderBadges();
    report();
  }
  function renderChat(keepInput) {
    var box = $('#msgs');
    if (!box) return;
    S.unread[S.chat] = 0;
    var l = S.conv[S.chat] || [], h = '', lastDay = '';
    l.forEach(function (m) {
      var d = new Date(m[2]).toDateString();
      if (d !== lastDay) { lastDay = d; h += '<div class="day">' + (d === new Date().toDateString() ? 'Today' : esc(d)) + '</div>'; }
      h += '<div class="m' + (m[0] ? ' me' : '') + '">' + esc(m[1]) + '<time>' + hhmm(m[2]) + '</time></div>';
    });
    if (!l.length) h = '<div class="day">Messages you send and receive here are kept on this phone.</div>';
    box.innerHTML = h;
    box.scrollTop = box.scrollHeight;
    if (!keepInput) { var i = $('#cin'); if (i) i.value = ''; }
    renderBadges();
  }
  function sendChat() {
    var i = $('#cin'), t = i ? i.value.trim() : '';
    if (!t) return;
    if (!send(OUT.MESSENGER_CHAT, [S.chat, t])) return;
    addMsg(S.chat, true, t, Date.now());
    i.value = '';
    renderChat(true);
  }
  function closePage() { if (!pageOpen()) return; $page.classList.remove('on'); $page.innerHTML = ''; S.chat = 0; report(); }

  // ---------------------------------------------------------------- Me
  var TILES = [
    ['profile', 'Profile', 'user'], ['looks', 'Change looks', 'shirt'], ['mentions', 'Mentions', 'at'],
    ['phone', 'Phone', 'phone'], ['achievements', 'Achievements', 'trophy'], ['camera', 'Camera', 'camera'],
    ['rares', 'Rare values', 'gem'], ['prestige', 'Prestige', 'star']
  ];
  function meHTML() {
    var stats = CURRENCIES.filter(function (c) { return c[0] === -1 || amount(c[0]) != null; });
    return '<div class="sbody" style="padding-top:2px">' +
      '<div class="mehero">' + av(S.me.name || 'Me', S.me.figure) + '<div class="tt"><h3>' + esc(S.me.name || 'Me') + '</h3><div class="sub">' + esc(S.me.motto || '') + '</div></div></div>' +
      '<div class="stats">' + stats.map(function (c) { var v = amount(c[0]); return '<div class="stat"><b>' + cicon(c[0]) + (v == null ? '…' : short(v)) + '</b><span>' + c[1] + '</span></div>'; }).join('') + '</div>' +
      '<div class="tools">' + TILES.map(function (t) {
        var cls = 'tool', dot = '';
        if (t[0] === 'prestige') {
          if (S.bp.avail === false) cls += ' dis';
          if (S.bp.avail && S.bp.unclaimed > 0) dot = '<i class="rdot"></i>';
        }
        return '<button class="' + cls + '" data-me="' + t[0] + '">' + dot + ic(t[2], 22) + '<span>' + t[1] + '</span></button>';
      }).join('') + '</div>' +
      '<div class="sec"><span>App</span></div><div class="list mx">' +
      '<button class="li" data-app="reload">' + ic('refresh') + '<span class="lt">Reload game<small>Fixes a stuck or frozen game</small></span><span class="end">' + ic('chevr', 18) + '</span></button>' +
      '<button class="li" data-app="chatlog">' + ic('file') + '<span class="lt">Saved chat log<small>Read room chat after a disconnect</small></span><span class="end">' + ic('chevr', 18) + '</span></button>' +
      '<button class="li" data-app="classic">' + ic('layout') + '<span class="lt">Classic UI<small>Switch back to the original game layout</small></span><span class="end">' + ic('chevr', 18) + '</span></button>' +
      '<button class="li danger" data-app="website">' + ic('logout') + '<span class="lt">Back to website<small>Leaves the game</small></span><span class="end">' + ic('chevr', 18) + '</span></button>' +
      '</div><div class="footnote">Peace UI beta · tap Back on your phone to close panels</div></div>';
  }

  // ---------------------------------------------------------------- misc
  var toastTimer = 0;
  function toast(t) {
    if (!$toast) return;
    $toast.textContent = t; $toast.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $toast.classList.remove('on'); }, 2200);
  }
  function post(o) { if (BRIDGE) { try { BRIDGE.postMessage(JSON.stringify(o)); } catch (e) {} } }
  var lastReported = null;
  function report() {
    var open = !!(S.sheet || pageOpen() || ($modal && $modal.classList.contains('on')) || ($pop && $pop.classList.contains('on')) || ($rpop && $rpop.classList.contains('on')));
    if (open !== lastReported) { lastReported = open; post({ a: 'overlay', open: open }); }
  }
  function closeAll() { closeModal(); closePage(); closeSheet(); $pop.classList.remove('on'); closeRoomMenu(); report(); }
  function back() {
    var shopPage = document.querySelector('.nitro-catalog.pu-page');
    if ($rpop.classList.contains('on')) closeRoomMenu();
    else if (shopPage) shopPage.classList.remove('pu-page');
    else if ($pop.classList.contains('on')) $pop.classList.remove('on');
    else if ($modal.classList.contains('on')) closeModal();
    else if (pageOpen()) closePage();
    else if (S.sheet) closeSheet();
    report();
  }
  function follow(id) {
    if (send(OUT.FOLLOW, [+id])) { var f = S.friends[id]; toast('Going to ' + (f ? f.name : 'friend') + '…'); closeAll(); }
  }
  function profile(id) { if (send(OUT.PROFILE, [+id, true])) closeAll(); }

  // ---------------------------------------------------------------- events
  function bind() {
    // Keep typing inside this UI from reaching Nitro's "type anywhere to chat" handler.
    ['keydown', 'keyup', 'keypress', 'input'].forEach(function (t) {
      root.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    // Broken avatar image: fall back to the initial letter.
    root.addEventListener('error', function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      var box = img.parentNode, n = (box && box.dataset && box.dataset.ini) || '?';
      if (box && box.classList.contains('mehead')) box.innerHTML = ic('user', 18);
      else if (box && box.classList.contains('av')) {
        box.classList.add('ini'); box.style.setProperty('--h', hue(n)); box.textContent = n.charAt(0).toUpperCase();
      } else img.remove();
    }, true);

    root.addEventListener('click', function (e) {
      var el = e.target.closest('[data-tab],[data-a],[data-ff],[data-f],[data-chat],[data-follow],[data-prof],[data-acc],[data-dec],[data-me],[data-app],[data-rt]');
      if (!el || el.disabled) return;
      var d = el.dataset;
      if (d.tab) {
        var t = d.tab;
        if (t === 'friends' || t === 'me') { if (S.sheet === t) closeSheet(); else openSheet(t, t === 'me' ? 'full' : 'half'); }
        else openNitro(t, el.textContent.trim());
        return;
      }
      if (d.a) {
        switch (d.a) {
          case 'rooms': openNitro('rooms', 'Rooms'); break;
          case 'room': if ($rpop.classList.contains('on')) closeRoomMenu(); else openRoomMenu(); break;
          case 'money': closeRoomMenu(); if ($pop.classList.toggle('on')) renderPop(); report(); break;
          case 'fclr': S.q = ''; var i = $('#fq'); if (i) i.value = ''; renderFriendBody(); break;
          case 'cclose': closeModal(); break;
          case 'back': closePage(); break;
          case 'accall':
            if (S.requests.length && send(OUT.ACCEPT, [S.requests.length].concat(S.requests.map(function (r) { return r.id; })))) {
              toast('Accepted ' + S.requests.length + ' friend request' + (S.requests.length > 1 ? 's' : '')); S.requests = []; changed('friends');
            }
            break;
        }
        return;
      }
      if (d.ff) { S.ff = d.ff; rerenderSheet(); return; }
      if (d.acc) {
        var r = S.requests.find(function (x) { return x.id === +d.acc; });
        if (send(OUT.ACCEPT, [1, +d.acc])) { S.requests = S.requests.filter(function (x) { return x.id !== +d.acc; }); toast('You and ' + (r ? r.name : 'them') + ' are now friends'); changed('friends'); }
        return;
      }
      if (d.dec) {
        if (send(OUT.DECLINE, [false, 1, +d.dec])) { S.requests = S.requests.filter(function (x) { return x.id !== +d.dec; }); changed('friends'); }
        return;
      }
      if (d.follow) { follow(d.follow); return; }
      if (d.chat) { openChat(d.chat); return; }
      if (d.prof) { profile(d.prof); return; }
      if (d.f) { openCard(d.f); return; }
      if (d.rt) { pressRoomTool(d.rt); return; }
      if (d.me) {
        if (d.me === 'profile' && S.me.id) { profile(S.me.id); return; }
        if (d.me === 'prestige' && S.bp.avail === false) { toast('Peace Prestige is not open right now'); return; }
        var tile = TILES.find(function (x) { return x[0] === d.me; });
        openNitro(d.me, tile ? tile[1] : 'This');
        return;
      }
      if (d.app) { closeAll(); post({ a: d.app }); return; }
    });

    root.addEventListener('input', function (e) {
      if (e.target.id === 'fq') { S.q = e.target.value; renderFriendBody(); }
      if (e.target.id === 'cin') { var s = root.querySelector('.send'); if (s) s.classList.toggle('on', !!e.target.value.trim()); }
    });
    root.addEventListener('submit', function (e) { if (e.target.id === 'compose') { e.preventDefault(); sendChat(); } });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.closest && e.target.closest('[role=button]')) e.target.click();
    });
    // Peace's client tells its HUD how many Prestige rewards wait to be claimed with this event.
    window.addEventListener('battlepass.unclaimed', function (e) {
      S.bp.unclaimed = Math.max(0, (e.detail && e.detail.count) || 0); changed('bp');
    });
    document.addEventListener('click', shopClick, true);
    // A tap on the game closes the currency and Room drop-downs.
    document.addEventListener('pointerdown', function (e) {
      if (e.target === host) return;
      if ($pop.classList.contains('on')) { $pop.classList.remove('on'); report(); }
      closeRoomMenu();
    }, true);
    root.addEventListener('pointerdown', dragStart);
    root.addEventListener('pointermove', dragMove);
    root.addEventListener('pointerup', dragEnd);
    root.addEventListener('pointercancel', dragEnd);
    window.addEventListener('resize', function () { if (S.sheet) setH(S.hmode); });

    if (BRIDGE) {
      BRIDGE.addEventListener('message', function (e) { if (e.data === 'back') back(); });
    }
  }

  // ---------------------------------------------------------------- start
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
  window.__peaceUiDebug = function () {
    return { connected: !!(sock && sock.readyState === 1), me: S.me, credits: S.credits, cur: S.cur, room: S.room, friends: friendList().length, requests: S.requests.length,
      found: Object.keys(NITRO).filter(function (k) { return !!findNitro(k); }), meToggle: !!meToggle(), bp: S.bp,
      roomTools: RT.filter(function (d) { return !!rtFind(d[0]); }).map(function (d) { return d[0]; }) };
  };
})();
