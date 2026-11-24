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
    conv: {}, unread: {}, ret: null,
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
  // Peace draws its room voice panel only inside the More sheet (#hud-more-voice). nitro.css shows that one
  // section as a panel under the top bar, so the sheet stays open (hidden) while the panel is open.
  var VOICE_KEY = 'peace.voice.panel.open';
  try { localStorage.setItem(VOICE_KEY, '0'); } catch (e) {}
  function voiceOpen() { try { return localStorage.getItem(VOICE_KEY) === '1'; } catch (e) { return false; } }
  function closeRoomTools() { if (voiceOpen()) return; var t = moreTab(); if (t && t.classList.contains('active')) t.click(); }
  function rtFind(key) {
    var box = roomTools(), def = RT.find(function (x) { return x[0] === key; });
    return box && def ? box.querySelector(def[1]) : null;
  }

  function openNitro(key, label) {
    closeAll(); S.ret = null;
    pressNitro(key).then(function (ok) { if (!ok) toast(label + ' is not available here yet'); });
  }

  // ---------------------------------------------------------------- dark Nitro windows
  // Nitro's windows are drawn for a light theme. Instead of a rule for every window, elements are
  // marked by their computed colours: near-black text turns light, light neutral backgrounds turn into
  // dark surfaces, light pastel backgrounds keep a faint tint, light borders turn subtle. nitro.css
  // styles the marks. They are data attributes, which React leaves alone when it re-renders.
  var darkSeen = new WeakSet(), darkQueued = false, darkObserver = null;
  var DARK_SKIP = 'img,canvas,svg,path,.btn,.chat-content,.chat-bubble,.avatar-image,.nitro-card-header,.nitro-card-tabs,.phone-window,.phone-outer,.user-profile .content-area,.builders-tools,.nitro-chat-history-content';
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
        if (L < 0.5 && sat(c) > 0.2) {
          // Coloured dark text keeps its hue, lifted to a light shade (a filter would also brighten the box).
          var m = function (v) { return Math.round(v + (255 - v) * 0.72); };
          el.style.setProperty('--pu-ink', 'rgb(' + m(c.r) + ',' + m(c.g) + ',' + m(c.b) + ')');
          el.setAttribute('data-pu-ink', 'tint');
        } else if (L < 0.3) el.setAttribute('data-pu-ink', '1');
        else if (L < 0.5) el.setAttribute('data-pu-ink', '2');
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
    polishScan();
  }
  // ---------------------------------------------------------------- window extras
  // Room owners on the Rooms grid (Peace only shows them in the list), zoom buttons on item previews,
  // even gaps in the Inventory grid, and the tab bar following the open window.
  function fiberProp(el, name) {
    var k = Object.keys(el).find(function (x) { return x.indexOf('__reactFiber') === 0; }), f = k && el[k];
    for (var i = 0; f && i < 8; i++, f = f.return) { var pr = f.memoizedProps; if (pr && pr[name]) return pr[name]; }
    return null;
  }
  // The DOM fiber can be the stale copy (React swaps two), so both are read and the one whose room name
  // matches the title on screen wins. A wrong owner is worse than none.
  function roomDataOf(el) {
    var k = Object.keys(el).find(function (x) { return x.indexOf('__reactFiber') === 0; }), f = k && el[k];
    var t = el.querySelector('[class*="titleromddas"]'), name = t ? t.textContent.trim() : '';
    for (var i = 0; f && i < 8; i++, f = f.return) {
      var c = [f.memoizedProps, f.alternate && f.alternate.memoizedProps];
      for (var j = 0; j < 2; j++) {
        var rd = c[j] && c[j].roomData; if (!rd) continue;
        if (!name || String(rd.roomName || rd._roomName || '').trim() === name) return rd;
      }
    }
    return null;
  }
  var THUMB = 'https://swfs.peacehotel.my/camera/thumbnail/';
  function polishScan() {
    document.querySelectorAll('.nitro-navigator .nav-thumbnail').forEach(function (el) {
      var rd = null; try { rd = roomDataOf(el); } catch (e) {}
      var owner = rd && (rd.ownerName || rd._ownerName) || '', tag = el.querySelector(':scope > .pu-owner');
      if (!owner) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('div'); tag.className = 'pu-owner'; el.appendChild(tag); }
      if (tag.textContent !== owner) tag.textContent = owner;
    });
    // List rows: My World shows no owner and no picture; both are added so every list looks the same.
    document.querySelectorAll('.nitro-navigator .navigator-item').forEach(function (el) {
      var col = el.querySelector('.flex-column'); if (!col) return;
      var rd = null; try { rd = roomDataOf(el); } catch (e) {}
      var th = el.querySelector(':scope > .pu-thumb');
      if (!el.querySelector(':scope > .room-thumbnail:not(.pu-thumb)')) {
        var id = rd && (rd.roomId || rd._roomId), b = col.querySelector('.badge');
        if (id) {
          if (!th) { th = document.createElement('div'); th.className = 'pu-thumb room-thumbnail thumbnailsmalslsk'; el.insertBefore(th, el.firstChild); }
          if (th.dataset.id !== String(id)) {
            th.dataset.id = id; th.innerHTML = '<img alt="" referrerpolicy="no-referrer">';
            var im = th.firstChild; im.onerror = function () { this.style.visibility = 'hidden'; }; im.src = THUMB + id + '.png';
          }
          var nb = th.querySelector('.badge');
          if (b) {
            if (!nb) { nb = document.createElement('div'); th.appendChild(nb); }
            if (nb.className !== b.className) nb.className = b.className;
            if (nb.innerHTML !== b.innerHTML) nb.innerHTML = b.innerHTML;
          } else if (nb) nb.remove();
        } else if (th) th.remove();
      }
      var tag = col.querySelector(':scope > .pu-owner');
      if (!tag && /Owner/i.test(el.textContent)) return;
      var owner = rd && (rd.ownerName || rd._ownerName) || '';
      if (!owner) { if (tag) tag.remove(); return; }
      if (!tag) { tag = document.createElement('div'); tag.className = 'pu-owner pu-lo'; col.appendChild(tag); }
      if (tag.textContent !== 'Owner: ' + owner) tag.textContent = 'Owner: ' + owner;
    });
    // Room details popover ("i"): a close button. Nitro closes it on a press anywhere else.
    document.querySelectorAll('.popover .room-info').forEach(function (ri) {
      var pop = ri.closest('.popover'); if (pop.querySelector(':scope > .pu-x')) return;
      var x = document.createElement('div');
      x.className = 'pu-x'; x.setAttribute('role', 'button'); x.setAttribute('aria-label', 'Close');
      x.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(function (t) { x.addEventListener(t, function (e) { e.stopPropagation(); }); });
      x.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        ['mousedown', 'mouseup', 'click'].forEach(function (t) { document.dispatchEvent(new MouseEvent(t, { bubbles: true })); });
      });
      pop.appendChild(x);
    });
    document.querySelectorAll('.nitro-catalog .catalog-default-image, .nitro-inventory:not(.trading) .g-col-5 > :first-child').forEach(function (box) {
      if (box.querySelector(':scope > .pu-zoom')) return;
      var b = document.createElement('div');
      b.className = 'pu-zoom'; b.setAttribute('role', 'button'); b.setAttribute('aria-label', 'Zoom in');
      b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2M11 8v6M8 11h6"/></svg>';
      box.appendChild(b);
    });
    invGrid();
    looksSync();
    setTabs();
  }
  // Peace's Inventory grid is virtual: rows of 40px tiles spread with space-between, so columns sit far apart
  // while rows are 4px apart. Zooming the scroller makes the tiles fill the width with the same gap both ways.
  function invGrid() {
    var sc = document.querySelector('.nitro-inventory:not(.trading) .g-col-7 > div');
    if (!sc) return;
    var row = sc.firstElementChild && sc.firstElementChild.firstElementChild, m = row && /repeat\((\d+),\s*(\d+)px\)/.exec(row.style.gridTemplateColumns || '');
    if (!m) return;
    // Aim for tiles about 76px wide (5 across on a phone): Peace picks its column count from the zoomed
    // width, so zooming to the width of that many 40px columns gives that many bigger tiles.
    var w = (sc.parentElement.clientWidth || 0), cols = Math.max(3, Math.round(w / 78)), z = w / (cols * (+m[2] + 4) - 2);
    z = z > 1 && z < 3 ? Math.floor(z * 100) / 100 : 1;
    if (String(sc.style.zoom) !== String(z)) sc.style.zoom = z;
  }
  function zoomOpen(btn) {
    var img = btn.parentElement.querySelector('.room-preview-image'), src = '';
    if (img) { var m = /url\("?(.*?)"?\)$/.exec(getComputedStyle(img).backgroundImage); src = m ? m[1] : ''; }
    if (!src) { var pic = btn.parentElement.querySelector('img'); src = pic ? pic.src : ''; }
    if (!src) return;
    S.zoom = 1;
    $zoom.innerHTML = '<div class="zstage" id="zstage"><img id="zimg" alt="" src="' + esc(src) + '"></div>' +
      '<div class="zbar"><button class="sqb" data-a="zout" aria-label="Zoom out">' + ic('zoomout', 18) + '</button><button class="sqb" data-a="zin" aria-label="Zoom in">' + ic('zoomin', 18) + '</button><button class="sqb" data-a="zclose" aria-label="Close">' + ic('x', 18) + '</button></div>';
    var im = $('#zimg');
    im.onload = function () { var st = $('#zstage'); S.zbase = Math.min((st.clientWidth - 24) / im.naturalWidth, (st.clientHeight - 24) / im.naturalHeight); zoomSet(1); };
    $zoom.classList.add('on'); report();
  }
  function zoomSet(z) {
    var im = $('#zimg'); if (!im || !im.naturalWidth) return;
    S.zoom = Math.max(1, Math.min(4, z));
    im.style.width = Math.round(im.naturalWidth * S.zbase * S.zoom) + 'px';
  }
  function zoomClose() { if (!$zoom || !$zoom.classList.contains('on')) return false; $zoom.classList.remove('on'); $zoom.innerHTML = ''; report(); return true; }
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
    var acts = card.querySelectorAll('.nitro-catalog-navigation-grid-container .layout-grid-item.active'), act = acts[acts.length - 1];
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

  // ---------------------------------------------------------------- full-screen Change looks
  // Nitro's avatar editor as one screen over the top bar and tab bar: the avatar on a stage, then one sheet
  // with the category tabs, the item types and the items; colours are their own step. nitro.css does the
  // layout; this sets the sizes it needs (--lk-* on <html>), adds the Colour button, and keeps the colour
  // step, the layer actions and the wardrobe toggle. Its state is in data attributes, which React leaves alone.
  var lkCard = null, lkQueued = false, lkVars = {}, lkSwipe = null;
  var LK_TYPES = { hr: 'Hair', ha: 'Hats', he: 'Head acc', ea: 'Eyewear', fa: 'Face', ch: 'Shirts', cp: 'Prints', cc: 'Jackets', ca: 'Necklaces', lg: 'Pants', sh: 'Shoes', wa: 'Belts', pt: 'Pets', mc: 'Misc' };
  function lkFind() {
    var c = document.querySelector('.draggable-window > .nitro-avatar-editor');
    return c && c.getClientRects().length ? c : null;
  }
  function lkVar(k, v) { if (lkVars[k] !== v) { lkVars[k] = v; document.documentElement.style.setProperty(k, v); } }
  function lkAttr(el, k, v) { if (v == null) { if (el.hasAttribute(k)) el.removeAttribute(k); } else if (el.getAttribute(k) !== v) el.setAttribute(k, v); }
  function looksQueue() { if (!lkQueued) { lkQueued = true; requestAnimationFrame(function () { lkQueued = false; looksSync(); }); } }
  function looksSync() {
    var card = lkFind();
    document.documentElement.classList.toggle('pu-looks', !!card);
    if (host) host.classList.toggle('looks', !!card);
    lkCard = card;
    if (!card) return;
    if (card.classList.contains('expanded')) lkColour(card, false);
    lkLayout(card);
    lkBar(card);
    lkWardrobe(card);
  }
  // My Wardrobe: Nitro's slot buttons are bare arrows (first = save the current look here, second = wear the
  // saved one, only when the slot has a look). nitro.css draws Save / Wear icons; this names them.
  function lkWardrobe(card) {
    var b = card.querySelectorAll('.saved-outfit-container .button-container > button');
    for (var i = 0; i < b.length; i++) {
      var l = b[i].previousElementSibling ? 'Wear this look' : 'Save current look here';
      if (b[i].getAttribute('aria-label') !== l) b[i].setAttribute('aria-label', l);
    }
  }
  // Sizes: the stage gets what is left after the tabs, the type row and three rows of items (240 to 360px).
  // Items: Nitro's list has 4 per row in 50px rows, zoomed so the tiles are square and fill the width.
  // Avatar: Nitro draws it at 2x; .75 of that on shorter stages. Palette: ~30px swatches, whole rows.
  function lkLayout(card) {
    var H = card.clientHeight, W = card.clientWidth;
    if (!H || !W) return;
    var head = card.querySelector(':scope > .nitro-card-header'), hh = head ? head.offsetHeight : 44;
    var inner = W - 24, z = Math.min(2.4, Math.max(1, inner / 196));
    var st = Math.round(Math.max(240, Math.min(360, H - hh - 114 - 150 * z)));
    var pc = Math.max(8, Math.floor((inner + 5) / 35)), ps = (inner - 8 - (pc - 1) * 5) / pc;
    var rows = Math.max(3, Math.floor((H - hh - st - 114 - 3) / (ps + 5)));
    lkVar('--lk-hh', hh + 'px'); lkVar('--lk-st', st + 'px'); lkVar('--lk-fk', st >= 330 ? '1' : st >= 255 ? '.75' : '.5');
    lkVar('--lk-z', z.toFixed(4)); lkVar('--lk-pc', String(pc)); lkVar('--lk-ps', ps.toFixed(2) + 'px');
    lkVar('--lk-ph', Math.floor(rows * (ps + 5) + 3) + 'px');
  }
  function lkBar(card) {
    var cc = card.querySelector('.choose-clothing');
    if (!cc) return;
    var bar = cc.querySelector(':scope > .pu-lkbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'pu-lkbar';
      bar.innerHTML = '<button type="button" class="pu-lkback" aria-label="Back to items"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>' +
        '<div class="pu-lkt"><b></b><small></small></div>' +
        '<div class="pu-lkslots"><button type="button" data-s="1"><i class="sw"></i>Colour 1</button><button type="button" data-s="2"><i class="sw"></i>Colour 2</button></div>' +
        '<button type="button" class="pu-lkcol" aria-label="Colours"><i class="sw"></i><i class="sw"></i></button>';
      cc.appendChild(bar);
    }
    // One palette, or two for two-colour items. Only palettes with colours count.
    var views = card.querySelectorAll('.avatar-color-palette-container .avatar-editor-palette-set-view'), n = 0, cols = [];
    for (var i = 0; i < views.length; i++) {
      var has = n < 2 && views[i].querySelector('.color-picker-frame');
      lkAttr(views[i], 'data-pu-pal', has ? String(++n) : null);
      if (has) { var a = views[i].querySelector('.color-picker-frame.active'); cols.push(a ? a.style.backgroundColor : ''); }
    }
    lkAttr(bar, 'data-n', String(n));
    lkAttr(bar, 'data-off', n ? null : '');
    if (!n) lkColour(card, false);
    var slot = card.getAttribute('data-pu-slot') === '2' && n > 1 ? '2' : '1';
    lkAttr(card, 'data-pu-slot', slot);
    var sws = bar.querySelectorAll('.pu-lkcol .sw'), sbs = bar.querySelectorAll('.pu-lkslots button');
    for (var j = 0; j < 2; j++) {
      var c = cols[j] || 'transparent';
      sws[j].style.background = c; sws[j].hidden = j >= n;
      sbs[j].querySelector('.sw').style.background = c;
      sbs[j].classList.toggle('on', String(j + 1) === slot);
    }
    var body = !!card.querySelector('.avatar-editor-tabs .nav-link.active .hd');
    var sel = cc.querySelector('.category-item > .selected'), type = '';
    if (sel) Object.keys(LK_TYPES).forEach(function (k) { if (sel.classList.contains(k + '-icon')) type = LK_TYPES[k]; });
    var layer = card.querySelector('.avatar-layer-row.active .avatar-layer-labels > :first-child');
    var sub = [type, layer ? layer.textContent.trim() : ''].filter(Boolean).join(' · ');
    var b = bar.querySelector('.pu-lkt b'), sm = bar.querySelector('.pu-lkt small'), title = body ? 'Skin colour' : 'Colour';
    if (b.textContent !== title) b.textContent = title;
    if (sm.textContent !== sub) sm.textContent = sub;
    sm.hidden = !sub;
  }
  function lkColour(card, on) {
    lkAttr(card, 'data-pu-colour', on ? '' : null);
    if (on) requestAnimationFrame(function () { lkScrollToActive(card); });
  }
  // Open the palette at the chosen colour.
  function lkScrollToActive(card) {
    var v = card.querySelector('[data-pu-pal="' + (card.getAttribute('data-pu-slot') || '1') + '"]'), a = v && v.querySelector('.color-picker-frame.active');
    if (!a || !v.clientHeight) return;
    v.scrollTop += a.getBoundingClientRect().top - v.getBoundingClientRect().top - (v.clientHeight - a.offsetHeight) / 2;
  }
  function lkFly(card, row) {
    card.querySelectorAll('.avatar-layer-row[data-pu-open]').forEach(function (r) { if (r !== row) r.removeAttribute('data-pu-open'); });
    if (row) row.setAttribute('data-pu-open', '');
  }
  function lkHanger(card) { var h = card.querySelector('.avatar-editor-tabs .tab-wardrobe'); if (h) h.click(); return !!h; }
  function looksClick(e) {
    var t = e.target, card = t.closest && t.closest('.nitro-avatar-editor');
    if (!card) return;
    if (t.closest('.pu-lkcol')) { lkFly(card, null); lkColour(card, true); return; }
    if (t.closest('.pu-lkback')) { lkColour(card, false); return; }
    var sb = t.closest('.pu-lkslots button');
    if (sb) { lkAttr(card, 'data-pu-slot', sb.getAttribute('data-s')); lkBar(card); requestAnimationFrame(function () { lkScrollToActive(card); }); return; }
    var row = t.closest('.avatar-layer-row');
    if (row) {
      // Up, down and remove keep the actions open; tapping the selected layer again opens or closes them.
      if (!t.closest('.btn-layers')) lkFly(card, row.classList.contains('active') && !row.hasAttribute('data-pu-open') ? row : null);
      return;
    }
    lkFly(card, null);
    var tab = t.closest('.avatar-editor-tabs .nav-link');
    if (tab) {
      lkColour(card, false);
      // My Wardrobe is a toggle in Nitro and covers the items here, so another category closes it.
      if (!tab.querySelector('.tab-wardrobe') && card.classList.contains('expanded')) setTimeout(function () { if (card.classList.contains('expanded')) lkHanger(card); }, 0);
    }
  }
  // Swipe the stage to turn the avatar.
  function looksDown(e) {
    var t = e.target;
    lkSwipe = t.closest && t.closest('.nitro-avatar-editor .figure-preview-container') && !t.closest('.arrow-container') ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
  }
  function looksUp(e) {
    var s = lkSwipe; lkSwipe = null;
    if (!s) return;
    var dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) < 36 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - s.t > 900) return;
    var a = document.querySelector('.nitro-avatar-editor .figure-preview-container .arrow-' + (dx < 0 ? 'left' : 'right'));
    if (a) a.click();
  }
  // Back inside Change looks: layer actions, then the colour step, then My Wardrobe, then the window.
  function looksBack() {
    var card = lkFind();
    if (!card || topNitroWindow() !== card.parentElement) return false;
    var open = card.querySelector('.avatar-layer-row[data-pu-open]');
    if (open) { open.removeAttribute('data-pu-open'); return true; }
    if (card.hasAttribute('data-pu-colour')) { lkColour(card, false); return true; }
    return card.classList.contains('expanded') && lkHanger(card);
  }
  function looksWatch() {
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (lkCard && lkCard.contains(m.target)) { looksQueue(); return; }
        if (m.type !== 'childList') continue;
        var lists = [m.addedNodes, m.removedNodes];
        for (var li = 0; li < 2; li++) for (var k = 0; k < lists[li].length; k++) {
          var n = lists[li][k];
          if (n.nodeType === 1 && (n.matches('.draggable-window,.nitro-avatar-editor') || (lkCard && n.contains(lkCard)) || n.querySelector('.nitro-avatar-editor'))) { looksQueue(); return; }
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
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
          var lists = [ms[i].addedNodes, ms[i].removedNodes];
          for (var li = 0; li < 2; li++) for (var k = 0; k < lists[li].length; k++) {
            var n = lists[li][k];
            if (n.nodeType === 1 && (n.matches('.draggable-window,.nitro-card,.popover') || n.querySelector('.nitro-card,.popover'))) { darkQueue(); return; }
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
    minus: '<path d="M5 12h14"/>',
    hardhat: '<path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M14 6a6 6 0 0 1 6 6v3M4 15v-3a6 6 0 0 1 6-6"/><rect x="2" y="15" width="20" height="4" rx="1"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    flag: '<path d="M4 22V4c4-3 8 3 16 0v11c-8 3-12-3-16 0"/>',
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
  // Full body (Peace's imager always draws the whole avatar, so hats and effects show like in the profile).
  function fbody(f, big) {
    var src = f.figure && IMAGER ? IMAGER + encodeURIComponent(f.figure) + '&direction=2&head_direction=2&gesture=sml' + (big ? '&size=l' : '') : '';
    return '<span class="fb' + (big ? ' big' : '') + '" data-ini="' + esc(f.name || '?') + '">' + (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="av ini" style="--h:' + hue(f.name || '?') + '">' + esc((f.name || '?').charAt(0).toUpperCase()) + '</span>') + (f.online && !big ? '<i class="st"></i>' : '') + '</span>';
  }
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
  var host, root, $tabs, $sheet, $shc, $page, $modal, $card, $toast, $pop, $rpop, $chip, $money, $zoom;
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
      '<div class="top"><button class="pill roomchip" data-a="room" hidden>' + ic('home', 16) + '<span class="ct">' + ic('user', 14) + '<b></b></span>' + ic('chevd', 15) + '</button>' +
      '<button class="pill money" data-a="money" id="crk"></button></div>' +
      '<div class="pop" id="pop"></div>' +
      '<div class="pop rpop" id="rpop"></div>' +
      '<div class="sheet" id="sheet"><div class="shc" id="shc"></div></div>' +
      '<nav class="tabs" id="tabs">' +
      tab('rooms', 'compass', 'Rooms') + tab('shop', 'bag', 'Shop') + tab('friends', 'users', 'Friends', 'fbadge') + tab('inventory', 'box', 'Inventory') +
      '<button class="tab" data-tab="me"><span class="ico"><span class="mehead" id="mehead">' + ic('user', 18) + '</span><i class="rdot" id="medot" hidden></i></span><span>Me</span></button>' +
      '</nav>' +
      '<div class="page" id="page"></div>' +
      '<div class="modal" id="modal"><div class="scrim" data-a="cclose"></div><div class="card" id="card"></div></div>' +
      '<div class="zoom" id="zoom"></div>' +
      '<div class="toast" id="toast" role="status"></div>';
    while (wrap.firstChild) root.appendChild(wrap.firstChild);
    document.body.appendChild(host);

    $tabs = $('#tabs'); $sheet = $('#sheet'); $shc = $('#shc'); $page = $('#page'); $modal = $('#modal'); $card = $('#card');
    $toast = $('#toast'); $pop = $('#pop'); $rpop = $('#rpop'); $chip = $('.roomchip'); $money = $('#crk'); $zoom = $('#zoom');

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
      $chip.setAttribute('aria-label', S.room.name + ' room menu');
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
    bubbles: function (el) { return el.classList.contains('icon-chat-disablebubble') ? ['bubble', 'Show bubbles', 1] : ['bubbleoff', 'Hide bubbles']; },
    like: function () { return ['heart', 'Like room']; },
    voice: function (el) { return ['mic', el.classList.contains('is-live') ? 'Voice (live)' : 'Room voice', el.classList.contains('active') || voiceOpen()]; },
    youtube: function () { return ['play', 'YouTube']; },
    builder: function () { return ['hardhat', 'Builder tools']; },
    settings: function () { return ['cog', 'Room settings']; }
  };
  // The Room menu: name (and the builder tools for owners) on top, four room tools in a 2x2 grid, then the
  // room's details and actions read from Nitro's Room info window, which stays open but hidden meanwhile.
  var RT_GRID = ['zoom', 'history', 'bubbles', 'voice'];
  function roomInfoEl() { return document.querySelector('.draggable-window > .nitro-room-info'); }
  function openRoomInfo() {
    if (roomInfoEl()) return Promise.resolve(roomInfoEl());
    var s = rtFind('settings'); if (!s) return Promise.resolve(null);
    document.documentElement.classList.add('pu-rihide'); S.riMine = true;
    s.click();
    return new Promise(function (resolve) {
      var n = 0;
      (function poll() { var el = roomInfoEl(); if (el || ++n > 20) return resolve(el); setTimeout(poll, 50); })();
    });
  }
  function closeRoomInfo(keep) {
    if (S.riMine && !keep) { var el = roomInfoEl(), x = el && el.querySelector('.nitro-card-header-close'); if (x) x.click(); }
    S.riMine = false;
    setTimeout(function () { document.documentElement.classList.remove('pu-rihide'); }, keep ? 0 : 80);
  }
  function openRoomMenu() {
    $pop.classList.remove('on');
    $rpop.innerHTML = '<div class="rhead"><div class="rht"><b>' + esc(S.room ? S.room.name : 'Room') + '</b></div></div><div class="empty sm">Loading room tools…</div>';
    $rpop.classList.add('on'); report();
    openRoomTools().then(function () {
      if (!$rpop.classList.contains('on')) return;
      renderRoomMenu();
      return openRoomInfo().then(function () { if ($rpop.classList.contains('on')) renderRoomMenu(); else closeRoomInfo(); });
    });
  }
  function closeRoomMenu(keepInfo) {
    if (!$rpop.classList.contains('on')) return;
    $rpop.classList.remove('on'); closeRoomInfo(keepInfo); closeRoomTools(); report();
  }
  function roomInfoParts() {
    var el = roomInfoEl(); S.riEls = [];
    if (!el) return null;
    function ref(n) { S.riEls.push(n); return S.riEls.length - 1; }
    var ca = el.querySelector('.content-area') || el, out = { rows: [], acts: [], btns: [] };
    ca.querySelectorAll('.text-muted.small').forEach(function (l) {
      var row = l.parentElement, k = l.textContent.replace(/:\s*$/, '').trim(), v = row.textContent.replace(l.textContent, '').trim();
      if (k && v) out.rows.push({ k: k, v: v, i: row.classList.contains('cursor-pointer') ? ref(row) : -1 });
    });
    var d = ca.querySelector('.overflow-auto.small'); out.desc = d ? d.textContent.trim() : '';
    out.tags = Array.prototype.map.call(ca.querySelectorAll('.text-tag'), function (t) { return t.textContent.trim(); }).filter(Boolean);
    ca.querySelectorAll('.btn-grpup > .btn').forEach(function (b) {
      var u = b.querySelector('.icon-house-small') ? ['home', 'Home room'] : b.querySelector('[title*="avourite"], [title*="favorite"]') ? ['star', 'Favourite'] :
        b.querySelector('.icon-link-room') ? ['link', 'Link'] : ['cog', (b.textContent || b.title || 'More').trim()];
      out.acts.push({ ic: u[0], t: u[1], on: b.classList.contains('is-active') || /_on|active/.test((b.querySelector('img') || {}).src || ''), i: ref(b), keep: u[0] === 'link' });
    });
    var gear = el.querySelector('.settings-room-infoss');
    if (gear) out.acts.push({ ic: 'cog', t: 'Settings', i: ref(gear) });
    ca.querySelectorAll('.btn:not(.btn-grpup > .btn):not(.settings-room-infoss)').forEach(function (b) {
      var t = b.textContent.trim(); if (t) out.btns.push({ t: t, danger: b.classList.contains('btn-danger') || /report/i.test(t), i: ref(b) });
    });
    return out;
  }
  function renderRoomMenu() {
    var box = roomTools();
    var name = box && box.querySelector('.rt-room-name');
    var ppl = S.room && S.room.users != null ? S.room.users + (S.room.max ? ' of ' + S.room.max : '') + ' people here' : '';
    var bld = box && box.querySelector(RT.find(function (x) { return x[0] === 'builder'; })[1]);
    var head = '<div class="rhead"><div class="rht"><b>' + esc(name ? name.textContent : (S.room ? S.room.name : 'Room')) + '</b>' + (ppl ? '<small>' + esc(ppl) + '</small>' : '') + '</div>' +
      (bld ? '<button class="sqb rbld" data-rt="builder" aria-label="Builder tools">' + ic('hardhat', 18) + '</button>' : '') + '</div>';
    if (!box) { $rpop.innerHTML = head + '<div class="empty sm">Room tools are not available here</div>'; return; }
    var btns = RT_GRID.map(function (key) {
      var el = rtFind(key); if (!el) return '';
      var u = RT_UI[key](el);
      return '<button class="rt' + (u[2] ? ' on' : '') + '" data-rt="' + key + '">' + ic(u[0], 22) + '<span>' + u[1] + '</span></button>';
    }).join('');
    var info = roomInfoParts(), sec = '';
    if (info) {
      var acts = info.acts.slice();
      ['like', 'youtube'].forEach(function (k) { var el = rtFind(k); if (el) { var u = RT_UI[k](el); acts.splice(k === 'like' ? 2 : acts.length, 0, { ic: u[0], t: k === 'like' ? 'Like' : u[1], rt: k }); } });
      sec = '<div class="rinfo"><div class="rlbl">Room info</div>' +
        info.rows.map(function (r) {
          return '<div class="rkv"><span>' + esc(r.k) + '</span>' + (r.i >= 0 ? '<button data-ri="' + r.i + '">' + esc(r.v) + ic('chevr', 14) + '</button>' : '<b>' + esc(r.v) + '</b>') + '</div>';
        }).join('') +
        (info.desc ? '<p class="rdesc">' + esc(info.desc) + '</p>' : '') +
        (info.tags.length ? '<div class="rtags">' + info.tags.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
        (acts.length ? '<div class="racts">' + acts.map(function (a) {
          return '<button class="ra' + (a.on ? ' on' : '') + '" ' + (a.rt ? 'data-rt="' + a.rt + '"' : 'data-ri="' + a.i + '"' + (a.keep ? ' data-keep="1"' : '')) + '>' + ic(a.ic, 18) + '<span>' + esc(a.t) + '</span></button>';
        }).join('') + '</div>' : '') +
        info.btns.map(function (b) { return '<button class="rbtn' + (b.danger ? ' danger' : '') + '" data-ri="' + b.i + '">' + (b.danger ? ic('flag', 16) : '') + esc(b.t) + '</button>'; }).join('') +
        '</div>';
    }
    $rpop.innerHTML = head + '<div class="rts">' + btns + '</div>' + sec;
  }
  function pressRoomInfo(i, keep, toggle) {
    var el = S.riEls && S.riEls[+i];
    if (!el || !el.isConnected) { toast('Not available in this room'); return; }
    if (toggle) { el.click(); setTimeout(renderRoomMenu, 250); return; }
    if (keep) document.documentElement.classList.remove('pu-rihide');
    el.click();
    closeRoomMenu(keep);
  }
  function pressRoomTool(key) {
    openRoomTools().then(function () {
      var el = rtFind(key);
      if (!el) { toast('Not available in this room'); return; }
      el.click();
      if (key === 'zoom' || key === 'bubbles' || key === 'like') setTimeout(renderRoomMenu, 160);
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
  var TABWIN = { rooms: '.nitro-navigator', shop: '.nitro-catalog', inventory: '.nitro-inventory:not(.trading)' };
  function tabWindow(t) { var c = TABWIN[t] && document.querySelector('.draggable-window > ' + TABWIN[t]); return c && c.getClientRects().length ? c.parentElement : null; }
  function setTabs() {
    if (!root) return;
    var on = S.sheet;
    if (!on) { var top = topNitroWindow(); Object.keys(TABWIN).forEach(function (t) { if (top && tabWindow(t) === top) on = t; }); }
    root.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === on); });
  }
  // One tab at a time: opening a tab closes the other game windows first.
  function closeNitroWindows(keep) {
    nitroWindows().forEach(function (w) { if (keep && w === keep) return; var x = w.querySelector('.nitro-card-header-close'); if (x) x.click(); });
  }

  // ---------------------------------------------------------------- sheets
  var SHEETS = {
    friends: { html: friendsHTML, after: function () { var i = $('#fq'); if (i) i.value = S.q; } },
    me: { html: meHTML }
  };
  function openSheet(k, mode) {
    S.ret = null; closeModal(); closePage(); $pop.classList.remove('on');
    S.sheet = k;
    $shc.innerHTML = SHEETS[k].html();
    if (SHEETS[k].after) SHEETS[k].after();
    $sheet.classList.add('open');
    setTabs();
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
    setTabs();
    report();
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
    return '<div class="whead"><h3>Friends</h3><button class="sqb" data-a="close" aria-label="Close">' + ic('x', 16) + '</button></div>' +
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
        return '<div class="row">' + av(r.name, r.figure) + '<span class="who"><span class="nm"><span>' + esc(r.name) + '</span></span></span><span class="acts"><button class="btn pri sm" data-acc="' + r.id + '">Accept</button><button class="act" data-dec="' + r.id + '" aria-label="Decline">' + ic('x', 18) + '</button></span></div>';
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
    $card.innerHTML = '<div class="hero">' + av(f.name, f.figure, 'xl') + '<div class="tt"><h4>' + esc(f.name) + rel(f.rel) + '</h4><div class="sub">' + (f.online ? '<i class="sdot"></i>Online' : '<i class="sdot off"></i>Offline') + '</div>' +
      (f.motto ? '<div class="motto">' + esc(f.motto) + '</div>' : '') + '</div><button class="sqb" data-a="cclose" aria-label="Close">' + ic('x', 16) + '</button></div>' +
      '<div class="trio"><button data-chat="' + f.id + '">' + ic('msg') + 'Message</button><button data-follow="' + f.id + '"' + (f.online && f.follow ? '' : ' disabled') + '>' + ic('follow') + 'Go to</button><button data-prof="' + f.id + '">' + ic('user') + 'Profile</button></div>';
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
    // Wallet on a 6-column grid: rows of three, and a short last row splits the full width.
    var left = stats.length % 3, cut = stats.length - left;
    return '<div class="whead"><h3>Me</h3><button class="sqb" data-a="close" aria-label="Close">' + ic('x', 16) + '</button></div>' + '<div class="sbody">' +
      '<div class="mehero">' + av(S.me.name || 'Me', S.me.figure, 'xl') + '<div class="tt"><h3>' + esc(S.me.name || 'Me') + '</h3><div class="sub">' + esc(S.me.motto || '') + '</div></div></div>' +
      '<div class="stats">' + stats.map(function (c, i) { var v = amount(c[0]); return '<div class="stat' + (i >= cut ? (left === 1 ? ' w6' : ' w3') : '') + '"><b>' + cicon(c[0]) + (v == null ? '…' : short(v)) + '</b><span>' + c[1] + '</span></div>'; }).join('') + '</div>' +
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
    var open = !!(S.sheet || pageOpen() || ($zoom && $zoom.classList.contains('on')) || ($modal && $modal.classList.contains('on')) || ($pop && $pop.classList.contains('on')) || ($rpop && $rpop.classList.contains('on')));
    if (open !== lastReported) { lastReported = open; post({ a: 'overlay', open: open }); }
  }
  function closeAll() { zoomClose(); closeModal(); closePage(); closeSheet(); $pop.classList.remove('on'); closeRoomMenu(); report(); }
  // Android Back button, one step at a time: the top panel of this UI, then the top Nitro window, then a
  // panel that opened that window (a profile opened from Friends goes back to Friends). The app asks the
  // player to close the game only when this answers that nothing was left to close.
  function nitroWindows() {
    return Array.prototype.filter.call(document.querySelectorAll('.draggable-window'), function (w) {
      return w.getClientRects().length > 0 && w.querySelector('.nitro-card-header-close');
    });
  }
  function topNitroWindow() {
    var best = null, bz = -Infinity;
    nitroWindows().forEach(function (w) { var z = parseInt(getComputedStyle(w).zIndex, 10) || 0; if (z >= bz) { bz = z; best = w; } });
    return best;
  }
  function back() {
    var shopPage = document.querySelector('.nitro-catalog.pu-page'), win;
    if (zoomClose()) { /* zoomed preview closed */ }
    else if ($rpop.classList.contains('on')) closeRoomMenu();
    else if ($pop.classList.contains('on')) $pop.classList.remove('on');
    else if ($modal.classList.contains('on')) closeModal();
    else if (pageOpen()) closePage();
    else if (S.sheet) closeSheet();
    else if (shopPage && topNitroWindow() === shopPage.closest('.draggable-window')) shopPage.classList.remove('pu-page');
    else if (looksBack()) { /* one step back inside Change looks */ }
    else if ((win = topNitroWindow())) {
      win.querySelector('.nitro-card-header-close').click();
      var ret = S.ret; S.ret = null;
      if (ret) setTimeout(function () { if (!nitroWindows().length && !S.sheet) { openSheet(ret.sheet, ret.mode); if (ret.card) openCard(ret.card); } }, 80);
    } else { S.ret = null; report(); return false; }
    report();
    return true;
  }
  function follow(id) {
    if (send(OUT.FOLLOW, [+id])) { var f = S.friends[id]; toast('Going to ' + (f ? f.name : 'friend') + '…'); closeAll(); }
  }
  function profile(id) {
    var ret = S.sheet ? { sheet: S.sheet, card: S.card } : null;
    if (send(OUT.PROFILE, [+id, true])) { closeAll(); S.ret = ret; }
  }

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
      var el = e.target.closest('[data-tab],[data-a],[data-ff],[data-f],[data-chat],[data-follow],[data-prof],[data-acc],[data-dec],[data-me],[data-app],[data-rt],[data-ri]');
      if (!el || el.disabled) return;
      var d = el.dataset;
      if (d.tab) {
        var t = d.tab;
        if (t === 'friends' || t === 'me') { if (S.sheet === t) closeSheet(); else { closeNitroWindows(); openSheet(t); } }
        else {
          var open = tabWindow(t);
          if (open && open === topNitroWindow()) { closeAll(); open.querySelector('.nitro-card-header-close').click(); setTabs(); }
          else { closeNitroWindows(open); if (open) closeAll(); else openNitro(t, el.textContent.trim()); }
        }
        return;
      }
      if (d.a) {
        switch (d.a) {
          case 'rooms': openNitro('rooms', 'Rooms'); break;
          case 'close': closeSheet(); break;
          case 'zin': zoomSet(S.zoom + 0.5); break;
          case 'zout': zoomSet(S.zoom - 0.5); break;
          case 'zclose': zoomClose(); break;
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
      if (d.rt) { if (d.rt === 'voice') { pressRoomTool('voice'); setTimeout(closeRoomMenu, 60); } else pressRoomTool(d.rt); return; }
      if (d.ri != null) { pressRoomInfo(d.ri, !!d.keep, el.classList.contains('ra') && !d.keep && !/Settings/.test(el.textContent)); return; }
      if (d.me) {
        if (d.me === 'profile' && S.me.id) { profile(S.me.id); return; }
        if (d.me === 'prestige' && S.bp.avail === false) { toast('Peace Prestige is not open right now'); return; }
        var tile = TILES.find(function (x) { return x[0] === d.me; });
        closeNitroWindows();
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
    document.addEventListener('click', looksClick, true);
    document.addEventListener('pointerdown', looksDown, true);
    document.addEventListener('pointerup', looksUp, true);
    document.addEventListener('pointercancel', function () { lkSwipe = null; }, true);
    document.addEventListener('click', function (e) {
      var z = e.target.closest && e.target.closest('.pu-zoom');
      if (z) { e.stopPropagation(); e.preventDefault(); zoomOpen(z); return; }
      // Closing the voice panel lets the hidden More sheet close too.
      if (e.target.closest && e.target.closest('#hud-more-voice .voice-tools-toggle')) setTimeout(function () { if (!$rpop.classList.contains('on')) closeRoomTools(); }, 80);
    }, true);
    // A tap on the game closes the currency and Room drop-downs.
    document.addEventListener('pointerdown', function (e) {
      if (e.target === host) return;
      if ($pop.classList.contains('on')) { $pop.classList.remove('on'); report(); }
      closeRoomMenu();
    }, true);
    window.addEventListener('resize', function () { invGrid(); looksQueue(); });
    looksWatch();
    looksSync();

    if (BRIDGE) {
      BRIDGE.addEventListener('message', function (e) { if (e.data === 'back') post({ a: 'back', handled: back() }); });
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
