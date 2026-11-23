(function () {
  // Dark windows: Nitro's windows are drawn for a light theme. Instead of a rule per window, mark
  // elements by their computed colours: near-black text becomes light, light neutral backgrounds
  // become dark surfaces, light pastel backgrounds keep a faint tint, light borders become subtle.
  // Marks are data attributes, which React leaves alone when it re-renders.
  var seen = new WeakSet();
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
  var SKIP = 'img,canvas,svg,path,.avatar-image,.nitro-card-header,.nitro-card-tabs,.phone-window,.phone-outer';
  function mark(el) {
    if (seen.has(el)) return;
    seen.add(el);
    if (el.closest(SKIP)) return;
    var cs = getComputedStyle(el);
    if (ownText(el) || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      var c = rgba(cs.color);
      if (c && c.a > 0.4) {
        var L = lum(c);
        if (L < 0.3) el.setAttribute('data-pu-ink', sat(c) > 0.35 ? 'tint' : '1');
        else if (L < 0.5 && sat(c) < 0.2) el.setAttribute('data-pu-ink', '2');
      }
    }
    var bi = cs.backgroundImage;
    // Flat colours and CSS gradients count; pictures (url) never do. Inline colours are content (colour swatches).
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
  var queued = false;
  function scan() {
    queued = false;
    var cards = document.querySelectorAll('.draggable-window .nitro-card .content-area');
    for (var i = 0; i < cards.length; i++) {
      var all = cards[i].getElementsByTagName('*');
      for (var j = 0; j < all.length; j++) mark(all[j]);
    }
  }
  function queue() { if (!queued) { queued = true; setTimeout(scan, 120); } }
  new MutationObserver(function (ms) {
    for (var i = 0; i < ms.length; i++) {
      var t = ms[i].target;
      if (t.nodeType === 1 && t.closest && t.closest('.draggable-window')) { queue(); return; }
      var add = ms[i].addedNodes;
      for (var k = 0; k < add.length; k++) {
        var n = add[k];
        if (n.nodeType === 1 && (n.matches('.draggable-window,.nitro-card') || n.querySelector('.nitro-card'))) { queue(); return; }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  queue();
  window.__puDarkScan = scan;
})();
