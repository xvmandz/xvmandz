'use strict';
/* PingUp UI toolkit: history-aware layers, sheets, menus, gestures, media viewer, players, safe text formatting.
   No application state lives here; app.js and pages.js build on these primitives. */
(() => {
  // Null-safe: a missing root (e.g. a closed chat screen) behaves like an empty container.
  const $ = (s, root = document) => root ? root.querySelector(s) : null;
  const $$ = (s, root = document) => root ? [...root.querySelectorAll(s)] : [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let translate = key => key;

  const icons = {
    chats: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8Z"/>',
    channels: '<path d="M4 11v2a1 1 0 0 0 1 1h2l5 4V6L7 10H5a1 1 0 0 0-1 1Z"/><path d="M16 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    contacts: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8"/><circle cx="9" cy="7" r="4"/>',
    calls: '<path d="M22 16.9V20a2 2 0 0 1-2.2 2A20 20 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 3a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c1 .3 2 .6 3 .7a2 2 0 0 1 1.7 1.9Z"/>',
    phone: '<path d="M22 16.9V20a2 2 0 0 1-2.2 2A20 20 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 3a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c1 .3 2 .6 3 .7a2 2 0 0 1 1.7 1.9Z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    video: '<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 9 6-4v14l-6-4"/>',
    saved: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>', back: '<path d="M19 12H5m6 6-6-6 6-6"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
    send: '<path d="m22 2-7 20-4-9L2 9 22 2ZM22 2 11 13"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    vmore: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    attach: '<path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7L9.1 17.3a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>', play: '<path d="M7 4.5v15l13-7.5Z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M9 9h.01M15 9h.01"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>', checks: '<path d="m2 12.5 4.5 4.5L16 7.5m-4 7.8 1.7 1.7L23 7.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
    verified: '<path d="m12 2 3 2 3.5.5.5 3.5 2 3-2 3-.5 3.5-3.5.5-3 2-3-2-3.5-.5-.5-3.5-2-3 2-3 .5-3.5L9 4Z"/><path d="m8 12 3 3 5-6"/>',
    crown: '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5Z"/>', star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
    moon: '<path d="M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    logout: '<path d="M9 21H4V3h5m5 4 5 5-5 5m-6-5h13"/>',
    reply: '<path d="m9 5-7 7 7 7M2 12h11a8 8 0 0 1 8 8"/>', forward: '<path d="m15 5 7 7-7 7m7-7H11a8 8 0 0 0-8 8"/>',
    pin: '<path d="M15 4.5 19.5 9l-3.2 1.2-3.6 3.6.5 4.2-1.4 1.4-3.5-3.5-4.8 4.8M8.3 9.3 11.8 5.8l1.4-1.4"/><path d="m9.5 7.5 7 7"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 19h14"/>', file: '<path d="M14 2H6v20h12V6l-4-4Zm0 0v5h5"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>', bellOff: '<path d="M18 8a6 6 0 0 0-9.3-5M6 8c0 7-3 7-3 9h14M10 21h4M3 3l18 18"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/>', eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3Z"/><circle cx="12" cy="13" r="4"/>', location: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    refresh: '<path d="M20 7V2m0 5h-5M4 17v5m0-5h5M5 7a8 8 0 0 1 14-2M19 17a8 8 0 0 1-14 2"/>',
    sparkles: '<path d="m12 3 2 6 6 3-6 2-2 7-2-7-7-2 7-3 2-6ZM20 2v4m-2-2h4"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m14 6 4 4"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    select: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>', link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    poll: '<path d="M5 20V10M12 20V4M19 20v-7"/>', sticker: '<path d="M15 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h7l8-8V6a3 3 0 0 0-3-3h-3Z"/><path d="M13 21v-5a3 3 0 0 1 3-3h5"/>',
    comment: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.3A8 8 0 1 1 21 12Z"/>', palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 21a3 3 0 0 1 0-6h2a3 3 0 0 0 3-3"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>', users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M16 11h6"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.7-2.5 2-2.5 4M12 17h.01"/>',
    bug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 7V4m-5 7H3m18 0h-4M4 18l3-2m13 2-3-2M8 4l2 3m6-3-2 3"/>', bulb: '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>', key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>', calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4"/>',
    text: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>', hash: '<path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18"/>', at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>', volume: '<path d="M11 5 6 9H2v6h4l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', zoom: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5M10.5 7.5v6m-3-3h6"/>',
  };
  const icon = (name, extra = '') => `<svg class="i ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.chats}</svg>`;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';
  const isMobile = () => matchMedia('(max-width: 899px)').matches;
  const vibrate = ms => { try { if (!reducedMotion()) navigator.vibrate?.(ms); } catch { /* unsupported */ } };

  /* ---------- Layers: every overlay/screen gets a history entry so Android Back closes it. ---------- */
  const stack = [];
  let seq = 0, ignorePops = 0;
  const deferred = [];
  // history.back() is asynchronous: a layer opened right after another one closes must not push its
  // history entry until that back navigation has landed, or Back would later skip a layer.
  function writeState(layer) {
    try { history.pushState({ pingup: layer.id, depth: stack.indexOf(layer) + 1 }, ''); } catch { /* sandboxed */ }
  }
  function pushLayer(close, name = 'layer') {
    const layer = { id: ++seq, close, name };
    stack.push(layer);
    if (ignorePops > 0) deferred.push(layer); else writeState(layer);
    return layer.id;
  }
  function closeLayer(id) {
    const index = stack.findIndex(layer => layer.id === id);
    if (index < 0) return;
    const layer = stack[index];
    const pendingEntry = deferred.indexOf(layer);
    if (pendingEntry >= 0) { deferred.splice(pendingEntry, 1); stack.splice(index, 1); layer.close(false); return; }
    if (index === stack.length - 1 - deferred.length) {
      stack.splice(index, 1);
      layer.close(false);
      ignorePops++;
      try { history.back(); } catch { ignorePops--; }
    } else {
      stack.splice(index, 1);
      layer.close(false);
    }
  }
  function hasLayer(name) { return stack.some(layer => layer.name === name); }
  window.addEventListener('popstate', event => {
    if (ignorePops > 0) {
      if (--ignorePops === 0) while (deferred.length) writeState(deferred.shift());
      return;
    }
    const depth = Number(event.state?.depth) || 0;
    while (stack.length > depth) stack.pop().close(true);
  });

  /* ---------- Sheets: bottom sheet on phones, centred panel on desktop. ---------- */
  let sheetZ = 60;
  function sheet({ title = '', body = '', footer = '', className = '', onClose, wide = false, full = false, label } = {}) {
    const root = document.createElement('div');
    root.className = `pu-sheet-root ${className}`;
    root.style.zIndex = String(++sheetZ);
    root.innerHTML = `<div class="pu-backdrop" data-sheet-close></div><section class="pu-sheet ${wide ? 'wide' : ''} ${full ? 'full' : ''}" role="dialog" aria-modal="true" ${title || label ? `aria-label="${esc(label || title)}"` : ''} tabindex="-1"><div class="pu-sheet-grip" aria-hidden="true"><i></i></div>${title ? `<header class="pu-sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-sheet-close aria-label="${esc(translate('common.close'))}">${icon('close')}</button></header>` : ''}<div class="pu-sheet-body"></div>${footer ? `<footer class="pu-sheet-foot">${footer}</footer>` : ''}</section>`;
    const bodyEl = $('.pu-sheet-body', root);
    if (body instanceof Node) bodyEl.append(body); else bodyEl.innerHTML = body;
    document.body.append(root);
    const previous = document.activeElement;
    let closed = false, layer;
    const finish = () => {
      if (closed) return;
      closed = true;
      root.classList.add('closing');
      setTimeout(() => root.remove(), reducedMotion() ? 0 : 220);
      onClose?.();
      if (previous?.isConnected && !isMobile()) previous.focus?.({ preventScroll: true });
    };
    layer = pushLayer(finish, 'sheet');
    const api = { el: root, body: bodyEl, close: () => closeLayer(layer), get closed() { return closed; } };
    root.addEventListener('click', event => { if (event.target.closest('[data-sheet-close]')) api.close(); });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); api.close(); }
      if (event.key === 'Tab') trapFocus(event, $('.pu-sheet', root));
    });
    dragToClose($('.pu-sheet', root), api.close, $('.pu-sheet-body', root));
    requestAnimationFrame(() => {
      root.classList.add('open');
      const target = $('[autofocus]', root) || (!isMobile() && $('input:not([type=hidden]),textarea,select', bodyEl)) || $('.pu-sheet', root);
      target?.focus?.({ preventScroll: true });
    });
    return api;
  }
  function trapFocus(event, container) {
    const focusable = $$('button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])', container).filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  /* Swipe the sheet (or its grip) down to dismiss. Only when its content is scrolled to the top. */
  function dragToClose(panel, close, scroller) {
    let startY = 0, dy = 0, active = false, startT = 0;
    panel.addEventListener('touchstart', event => {
      if (!isMobile() || event.touches.length !== 1) return;
      if (scroller && scroller.scrollTop > 0 && !event.target.closest('.pu-sheet-grip,.pu-sheet-head')) return;
      if (event.target.closest('input,textarea,select,[data-no-drag]')) return;
      startY = event.touches[0].clientY; dy = 0; active = true; startT = Date.now();
      panel.style.transition = 'none';
    }, { passive: true });
    panel.addEventListener('touchmove', event => {
      if (!active) return;
      dy = Math.max(0, event.touches[0].clientY - startY);
      if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    const end = () => {
      if (!active) return;
      active = false;
      panel.style.transition = '';
      const fast = dy > 40 && Date.now() - startT < 250;
      if (dy > Math.min(160, panel.offsetHeight * 0.3) || fast) { panel.style.transform = 'translateY(100%)'; close(); }
      else panel.style.transform = '';
    };
    panel.addEventListener('touchend', end);
    panel.addEventListener('touchcancel', end);
  }

  /* ---------- Action menus: dropdown at pointer on desktop, sheet on phones. ---------- */
  function menu(items, { x, y, anchor, header = '', title = '' } = {}) {
    const visible = items.filter(Boolean);
    const list = `${header}<div class="pu-menu-list" role="menu">${visible.map((item, index) => item.separator ? '<hr>' : `<button role="menuitem" class="pu-menu-item ${item.danger ? 'danger' : ''} ${item.active ? 'active' : ''}" data-menu-index="${index}" ${item.id ? `data-menu-id="${esc(item.id)}"` : ''} ${item.disabled ? 'disabled' : ''}>${item.icon ? icon(item.icon) : ''}<span>${esc(item.label)}</span>${item.hint ? `<small>${esc(item.hint)}</small>` : ''}${item.active ? icon('check', 'tick') : ''}</button>`).join('')}</div>`;
    const choose = (index, close) => { const item = visible[index]; close(); setTimeout(() => item?.action?.(), 0); };
    if (isMobile() || (x === undefined && !anchor)) {
      const s = sheet({ title, body: list, className: 'pu-menu-sheet' });
      s.el.addEventListener('click', event => { const b = event.target.closest('[data-menu-index]'); if (b) choose(Number(b.dataset.menuIndex), s.close); });
      return s;
    }
    const root = document.createElement('div');
    root.className = 'pu-popover-root';
    root.innerHTML = `<div class="pu-popover" tabindex="-1">${list}</div>`;
    document.body.append(root);
    const pop = $('.pu-popover', root);
    const rect = anchor?.getBoundingClientRect();
    const px = rect ? rect.right : x, py = rect ? rect.bottom + 6 : y;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(px - (rect ? w : 0), innerWidth - w - 8))}px`;
    pop.style.top = `${Math.max(8, py + h > innerHeight - 8 ? py - h - (rect ? rect.height + 12 : 0) : py)}px`;
    let closed = false;
    const layer = pushLayer(() => { closed = true; root.classList.add('closing'); setTimeout(() => root.remove(), 140); }, 'menu');
    const close = () => !closed && closeLayer(layer);
    root.addEventListener('pointerdown', event => { if (!event.target.closest('.pu-popover')) close(); });
    root.addEventListener('click', event => { const b = event.target.closest('[data-menu-index]'); if (b) choose(Number(b.dataset.menuIndex), close); });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        const buttons = $$('.pu-menu-item:not([disabled])', root), current = buttons.indexOf(document.activeElement);
        buttons[(current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    });
    requestAnimationFrame(() => { root.classList.add('open'); $('.pu-menu-item', root)?.focus({ preventScroll: true }); });
    return { el: root, close };
  }

  function confirmDialog({ title, text = '', confirm, cancel, danger = false, input = null }) {
    return new Promise(resolve => {
      let answered = false;
      const field = input ? `<label class="field"><span>${esc(input.label)}</span><input data-confirm-input type="${input.type || 'text'}" autocomplete="${input.autocomplete || 'off'}" ${input.placeholder ? `placeholder="${esc(input.placeholder)}"` : ''}></label>` : '';
      const s = sheet({
        title, body: `${text ? `<p class="pu-confirm-text">${esc(text)}</p>` : ''}${field}`, className: 'pu-confirm',
        footer: `<button class="btn ghost" data-confirm="0">${esc(cancel || translate('common.cancel'))}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-confirm="1">${esc(confirm || translate('common.confirm'))}</button>`,
        onClose: () => { if (!answered) resolve(input ? null : false); },
      });
      s.el.addEventListener('click', event => {
        const b = event.target.closest('[data-confirm]');
        if (!b) return;
        answered = true;
        const value = input ? $('[data-confirm-input]', s.el).value : true;
        s.close();
        resolve(b.dataset.confirm === '1' ? value : (input ? null : false));
      });
      s.el.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.matches('[data-confirm-input]')) $('[data-confirm="1"]', s.el).click(); });
    });
  }

  /* ---------- Toasts ---------- */
  function toast(message, type = 'info', { action, onAction, duration = 4200 } = {}) {
    const host = $('#toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.textContent = message;
    el.append(text);
    if (action) {
      const button = document.createElement('button');
      button.className = 'toast-action';
      button.textContent = action;
      button.onclick = () => { onAction?.(); remove(); };
      el.append(button);
    }
    host.append(el);
    const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); };
    setTimeout(remove, duration);
    while (host.children.length > 4) host.firstElementChild.remove();
  }

  /* ---------- Gestures ---------- */
  // Horizontal swipe on a child matching selector. Vertical scrolling and Android edge-back gestures win.
  function swipeAction(container, selector, { direction = 1, threshold = 64, onSwipe, enabled = () => true } = {}) {
    let target = null, startX = 0, startY = 0, dx = 0, locked = null, fired = false;
    container.addEventListener('touchstart', event => {
      if (event.touches.length !== 1 || !enabled()) return;
      const t = event.touches[0];
      // Leave 24px edges to the system back gesture.
      if (t.clientX < 24 || t.clientX > innerWidth - 24) return;
      target = event.target.closest(selector);
      if (!target || event.target.closest('input,textarea,audio,video,.pu-audio,[data-no-swipe]')) { target = null; return; }
      startX = t.clientX; startY = t.clientY; dx = 0; locked = null; fired = false;
    }, { passive: true });
    container.addEventListener('touchmove', event => {
      if (!target) return;
      const t = event.touches[0];
      const mx = t.clientX - startX, my = t.clientY - startY;
      if (locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) locked = Math.abs(mx) > Math.abs(my) * 1.4 ? 'x' : 'y';
      if (locked !== 'x') return;
      dx = Math.max(0, Math.min(110, mx * direction));
      target.style.transition = 'none';
      target.style.transform = `translateX(${dx * direction}px)`;
      target.classList.toggle('swipe-ready', dx >= threshold);
      if (dx >= threshold && !fired) { fired = true; vibrate(8); }
      if (dx < threshold) fired = false;
    }, { passive: true });
    const end = () => {
      if (!target) return;
      const el = target;
      target = null;
      el.style.transition = '';
      el.style.transform = '';
      el.classList.remove('swipe-ready');
      if (locked === 'x' && dx >= threshold) onSwipe(el);
    };
    container.addEventListener('touchend', end);
    container.addEventListener('touchcancel', end);
  }
  function longPress(container, selector, callback, delay = 450) {
    let timer = null, startX = 0, startY = 0, fired = false;
    container.addEventListener('touchstart', event => {
      const el = event.target.closest(selector);
      if (!el || event.touches.length !== 1 || event.target.closest('a,input,textarea,audio,video,.pu-audio button,[data-no-press]')) return;
      startX = event.touches[0].clientX; startY = event.touches[0].clientY; fired = false;
      timer = setTimeout(() => { fired = true; vibrate(12); callback(el, { x: startX, y: startY }); }, delay);
    }, { passive: true });
    container.addEventListener('touchmove', event => {
      if (timer && (Math.abs(event.touches[0].clientX - startX) > 10 || Math.abs(event.touches[0].clientY - startY) > 10)) { clearTimeout(timer); timer = null; }
    }, { passive: true });
    const end = event => { clearTimeout(timer); timer = null; if (fired) { event.preventDefault(); fired = false; } };
    container.addEventListener('touchend', end);
    container.addEventListener('touchcancel', end);
    container.addEventListener('contextmenu', event => {
      const el = event.target.closest(selector);
      if (!el || event.target.closest('a,input,textarea')) return;
      event.preventDefault();
      if (!('ontouchstart' in window) || event.pointerType === 'mouse' || event.button === 2) callback(el, { x: event.clientX, y: event.clientY });
    });
  }
  function pullToRefresh(scroller, onRefresh) {
    let startY = 0, dy = 0, active = false;
    const indicator = document.createElement('div');
    indicator.className = 'pu-ptr';
    indicator.innerHTML = icon('refresh');
    scroller.prepend(indicator);
    scroller.addEventListener('touchstart', event => {
      if (scroller.scrollTop > 0 || event.touches.length !== 1) return;
      startY = event.touches[0].clientY; dy = 0; active = true;
    }, { passive: true });
    scroller.addEventListener('touchmove', event => {
      if (!active) return;
      dy = Math.max(0, Math.min(90, (event.touches[0].clientY - startY) * 0.5));
      indicator.style.height = `${dy}px`;
      indicator.classList.toggle('ready', dy > 60);
    }, { passive: true });
    scroller.addEventListener('touchend', async () => {
      if (!active) return;
      active = false;
      if (dy > 60) {
        indicator.classList.add('loading');
        indicator.style.height = '48px';
        try { await onRefresh(); } finally { indicator.classList.remove('loading', 'ready'); indicator.style.height = '0'; }
      } else indicator.style.height = '0';
    });
  }

  /* ---------- Media viewer with zoom, swipe between items and swipe-down to close. ---------- */
  function viewer(items, startIndex = 0, origin = null) {
    if (!items.length) return;
    let index = Math.max(0, Math.min(items.length - 1, startIndex)), scale = 1, tx = 0, ty = 0;
    const root = document.createElement('div');
    root.className = 'pu-viewer';
    root.innerHTML = `<div class="pu-viewer-bg"></div><header class="pu-viewer-bar"><button class="icon-btn" data-viewer-close aria-label="${esc(translate('common.close'))}">${icon('close')}</button><span class="pu-viewer-count"></span><span class="pu-viewer-name"></span><a class="icon-btn" data-viewer-download download aria-label="${esc(translate('media.download'))}">${icon('download')}</a></header><div class="pu-viewer-stage"></div><button class="pu-viewer-nav prev" aria-label="${esc(translate('media.previous'))}">${icon('back')}</button><button class="pu-viewer-nav next" aria-label="${esc(translate('media.next'))}">${icon('arrow')}</button>`;
    document.body.append(root);
    const stage = $('.pu-viewer-stage', root);
    let closed = false;
    const layer = pushLayer(() => {
      closed = true;
      $$('video', root).forEach(v => v.pause());
      root.classList.remove('open');
      setTimeout(() => root.remove(), reducedMotion() ? 0 : 220);
    }, 'viewer');
    const close = () => !closed && closeLayer(layer);
    const apply = (animate = false) => {
      const media = $('.pu-viewer-media', stage);
      if (!media) return;
      media.style.transition = animate ? 'transform .2s ease' : 'none';
      media.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
    };
    const render = () => {
      const item = items[index];
      scale = 1; tx = 0; ty = 0;
      stage.innerHTML = item.kind === 'video'
        ? `<video class="pu-viewer-media" src="${esc(item.url)}" controls autoplay playsinline preload="metadata"></video>`
        : `<img class="pu-viewer-media" src="${esc(item.url)}" alt="${esc(item.name || '')}" draggable="false">`;
      $('.pu-viewer-count', root).textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
      $('.pu-viewer-name', root).textContent = item.name || '';
      const download = $('[data-viewer-download]', root);
      download.href = item.url + (item.url.includes('?') ? '&' : '?') + 'download=1';
      $('.prev', root).hidden = index === 0;
      $('.next', root).hidden = index === items.length - 1;
    };
    const go = step => { const next = index + step; if (next < 0 || next >= items.length) return; index = next; render(); };
    render();
    // FLIP: grow from the thumbnail into the viewer.
    if (origin && !reducedMotion()) {
      const from = origin.getBoundingClientRect();
      const media = $('.pu-viewer-media', stage);
      media.style.transformOrigin = 'top left';
      requestAnimationFrame(() => {
        const to = media.getBoundingClientRect();
        if (!to.width) { media.style.transformOrigin = ''; return; }
        media.animate([{ transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(${from.width / to.width},${from.height / to.height})`, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.finally(() => { media.style.transformOrigin = ''; });
      });
    }
    requestAnimationFrame(() => root.classList.add('open'));
    root.addEventListener('click', event => {
      if (event.target.closest('[data-viewer-close]') || event.target === stage) close();
      if (event.target.closest('.prev')) go(-1);
      if (event.target.closest('.next')) go(1);
    });
    root.addEventListener('keydown', event => { if (event.key === 'ArrowLeft') go(-1); if (event.key === 'ArrowRight') go(1); if (event.key === 'Escape') close(); });
    root.tabIndex = -1;
    root.focus();
    stage.addEventListener('wheel', event => { if (items[index].kind === 'video') return; event.preventDefault(); scale = Math.max(1, Math.min(5, scale * (event.deltaY < 0 ? 1.15 : 0.87))); if (scale === 1) { tx = 0; ty = 0; } apply(true); }, { passive: false });
    stage.addEventListener('dblclick', () => { scale = scale > 1 ? 1 : 2.5; tx = 0; ty = 0; apply(true); });
    let touches = [], startDist = 0, startScale = 1, startX = 0, startY = 0, baseX = 0, baseY = 0, mode = null, lastTap = 0;
    stage.addEventListener('touchstart', event => {
      touches = [...event.touches];
      if (touches.length === 2) { mode = 'pinch'; startDist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY); startScale = scale; }
      else if (touches.length === 1) {
        startX = touches[0].clientX; startY = touches[0].clientY; baseX = tx; baseY = ty; mode = null;
        const now = Date.now();
        if (now - lastTap < 280 && items[index].kind !== 'video') { scale = scale > 1 ? 1 : 2.5; tx = 0; ty = 0; apply(true); }
        lastTap = now;
      }
    }, { passive: true });
    stage.addEventListener('touchmove', event => {
      const list = [...event.touches];
      if (mode === 'pinch' && list.length === 2) {
        const dist = Math.hypot(list[0].clientX - list[1].clientX, list[0].clientY - list[1].clientY);
        scale = Math.max(1, Math.min(5, startScale * dist / startDist)); apply();
        return;
      }
      if (list.length !== 1) return;
      const mx = list[0].clientX - startX, my = list[0].clientY - startY;
      if (scale > 1) { tx = baseX + mx; ty = baseY + my; apply(); return; }
      if (!mode && (Math.abs(mx) > 10 || Math.abs(my) > 10)) mode = Math.abs(mx) > Math.abs(my) ? 'swipe' : 'dismiss';
      const media = $('.pu-viewer-media', stage);
      if (mode === 'swipe') { media.style.transition = 'none'; media.style.transform = `translateX(${mx}px)`; }
      if (mode === 'dismiss') { media.style.transition = 'none'; media.style.transform = `translateY(${my}px) scale(${1 - Math.min(0.3, Math.abs(my) / 900)})`; $('.pu-viewer-bg', root).style.opacity = String(1 - Math.min(0.8, Math.abs(my) / 400)); }
    }, { passive: true });
    stage.addEventListener('touchend', event => {
      if (event.touches.length) return;
      const t = event.changedTouches[0], mx = t.clientX - startX, my = t.clientY - startY;
      if (mode === 'swipe' && Math.abs(mx) > 70) go(mx < 0 ? 1 : -1);
      else if (mode === 'dismiss' && Math.abs(my) > 110) { close(); return; }
      $('.pu-viewer-bg', root).style.opacity = '';
      if (scale <= 1) { tx = 0; ty = 0; scale = 1; apply(true); }
      mode = null;
    });
  }

  /* ---------- Audio player (music, voice). One track plays at a time. ---------- */
  let currentAudio = null;
  const fmtTime = seconds => !Number.isFinite(seconds) ? '0:00' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  function audioMarkup(file, voice = false) {
    return `<div class="pu-audio ${voice ? 'voice' : ''}" data-src="${esc(file.url)}" data-no-swipe><button class="pu-audio-play" aria-label="${esc(translate('media.play'))}">${icon('play')}</button><div class="pu-audio-main">${voice ? '' : `<strong class="pu-audio-title">${esc(file.name)}</strong>`}<div class="pu-audio-track" role="slider" tabindex="0" aria-label="${esc(translate('media.seek'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i class="pu-audio-fill"></i></div><div class="pu-audio-meta"><span class="pu-audio-time">0:00</span>${voice ? '' : `<span>${esc(fileSize(file.size))}</span>`}</div></div><button class="pu-audio-speed" aria-label="${esc(translate('media.speed'))}">1×</button>${voice ? '' : `<a class="icon-btn pu-audio-download" href="${esc(file.url)}${String(file.url).includes('?') ? '&' : '?'}download=1" download aria-label="${esc(translate('media.download'))}">${icon('download')}</a>`}</div>`;
  }
  function audioFor(root) {
    if (root._audio) return root._audio;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = root.dataset.src;
    root._audio = audio;
    const fill = $('.pu-audio-fill', root), time = $('.pu-audio-time', root), track = $('.pu-audio-track', root), play = $('.pu-audio-play', root);
    const update = () => {
      const pct = audio.duration ? audio.currentTime / audio.duration * 100 : 0;
      fill.style.width = `${pct}%`;
      track.setAttribute('aria-valuenow', String(Math.round(pct)));
      time.textContent = audio.paused && !audio.currentTime ? fmtTime(audio.duration) : `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
    };
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('loadedmetadata', update);
    audio.addEventListener('play', () => { play.innerHTML = icon('pause'); root.classList.add('playing'); });
    audio.addEventListener('pause', () => { play.innerHTML = icon('play'); root.classList.remove('playing'); });
    audio.addEventListener('ended', () => { audio.currentTime = 0; update(); });
    audio.addEventListener('error', () => { root.classList.add('error'); time.textContent = translate('media.unavailable'); });
    return audio;
  }
  document.addEventListener('click', event => {
    const root = event.target.closest('.pu-audio');
    if (!root) return;
    if (event.target.closest('.pu-audio-play')) {
      const audio = audioFor(root);
      if (audio.paused) { if (currentAudio && currentAudio !== audio) currentAudio.pause(); currentAudio = audio; audio.play().catch(() => toast(translate('media.unavailable'), 'error')); }
      else audio.pause();
    }
    if (event.target.closest('.pu-audio-speed')) {
      const audio = audioFor(root), speeds = [1, 1.5, 2, 0.75], next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length];
      audio.playbackRate = next;
      event.target.closest('.pu-audio-speed').textContent = `${next}×`;
    }
    const track = event.target.closest('.pu-audio-track');
    if (track) {
      const audio = audioFor(root), rect = track.getBoundingClientRect();
      const seek = () => { if (audio.duration) audio.currentTime = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * audio.duration; };
      if (audio.readyState >= 1) seek(); else audio.addEventListener('loadedmetadata', seek, { once: true });
    }
  });
  document.addEventListener('keydown', event => {
    const track = event.target.closest?.('.pu-audio-track');
    if (!track || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const audio = audioFor(track.closest('.pu-audio'));
    if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + (event.key === 'ArrowRight' ? 5 : -5)));
  });

  function fileSize(size) {
    const n = Number(size) || 0;
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
  }

  /* ---------- Safe text formatting: escape first, then a small markdown-like subset. ---------- */
  const urlPattern = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
  function inlineMarks(escaped) {
    return escaped
      .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" tabindex="0" role="button" aria-label="spoiler">$1</span>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(.+?)__(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{2,40})/gu, '$1<button class="hashtag" data-hashtag="$2">#$2</button>')
      .replace(/(^|[^\p{L}\p{N}_])@([a-zA-Z][a-zA-Z0-9_]{2,31})/gu, '$1<button class="mention" data-mention="$2">@$2</button>');
  }
  function format(text) {
    const source = String(text ?? '');
    const parts = [];
    let last = 0;
    // Code spans and URLs are atomic: no formatting inside them.
    const pattern = new RegExp('```([\\s\\S]+?)```|`([^`\\n]+)`|' + urlPattern.source, 'gi');
    for (const match of source.matchAll(pattern)) {
      parts.push(inlineMarks(esc(source.slice(last, match.index))));
      if (match[1] !== undefined) parts.push(`<pre><code>${esc(match[1].replace(/^\n/, ''))}</code></pre>`);
      else if (match[2] !== undefined) parts.push(`<code>${esc(match[2])}</code>`);
      else {
        let url = match[0];
        try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw 0; parts.push(`<a href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(url)}</a>`); }
        catch { parts.push(esc(url)); }
      }
      last = match.index + match[0].length;
    }
    parts.push(inlineMarks(esc(source.slice(last))));
    return parts.join('').replace(/\n/g, '<br>');
  }
  function firstUrl(text) {
    const match = String(text || '').match(urlPattern);
    if (!match) return null;
    try { const url = new URL(match[0]); return ['http:', 'https:'].includes(url.protocol) ? url : null; } catch { return null; }
  }
  document.addEventListener('click', event => {
    const spoiler = event.target.closest('.spoiler');
    if (spoiler) { spoiler.classList.add('revealed'); event.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.classList?.contains('spoiler')) event.target.classList.add('revealed'); });

  /* ---------- Small helpers ---------- */
  function animateIn(el, cls = 'enter') {
    if (!el || reducedMotion()) return;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }
  function debounce(fn, wait) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }
  // Keep the composer above the on-screen keyboard (Android PWA / iOS).
  if (window.visualViewport) {
    const sync = () => {
      const vv = window.visualViewport;
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
      document.documentElement.style.setProperty('--keyboard', `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`);
      document.documentElement.classList.toggle('keyboard-open', innerHeight - vv.height > 120);
    };
    visualViewport.addEventListener('resize', sync);
    visualViewport.addEventListener('scroll', sync);
    sync();
  }

  window.PU = Object.freeze({
    $, $$, esc, icon, icons, isMobile, reducedMotion, vibrate, pushLayer, closeLayer, hasLayer, sheet, menu, confirm: confirmDialog, toast,
    swipeAction, longPress, pullToRefresh, viewer, audioMarkup, fileSize, fmtTime, format, firstUrl, animateIn, debounce,
    setTranslator(fn) { translate = fn; },
  });
})();
