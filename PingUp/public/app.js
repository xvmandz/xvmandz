'use strict';
/* PingUp 2.1 core: state, API, shell (rail + bottom navigation), chat list, sync loop, authentication.
   The chat screen lives in chat.js and secondary pages in pages.js; both extend window.PingUp. */
(() => {
  const { $, $$, esc, icon } = PU;
  const app = $('#app');
  const VERSION = '2.1.0';
  const PAGES = ['chats', 'channels', 'contacts', 'calls', 'settings'];
  function readPref(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
  function storePref(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

  const state = {
    user: null, csrf: '', config: {}, dict: {}, locale: readPref('pingup.locale', 'uk'), theme: readPref('pingup.theme', 'dark'),
    hasLocale: !!readPref('pingup.locale', ''), hasTheme: !!readPref('pingup.theme', ''),
    page: 'chats', active: null, conversations: [], contacts: [], contactRequests: 0, folders: [], privacy: {}, premium: {}, settings: {},
    messages: new Map(), drafts: new Map(), changeCursors: new Map(), typing: new Map(), scroll: new Map(),
    filter: 'all', chatQuery: '', showArchive: false, authMode: 'login', connected: true, syncBusy: false, timer: null,
    eventCursor: 0, feedbackUnread: 0, admin: null, lastSync: 0,
  };
  const pages = new Map();
  const listeners = new Map();
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); };
  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) { try { fn(...args); } catch (error) { console.error(error); } } };

  /* ---------- i18n ---------- */
  function t(key, params = {}) {
    let value = state.dict[key] ?? key;
    for (const [k, v] of Object.entries(params)) value = value.replaceAll(`{${k}}`, String(v));
    return value;
  }
  PU.setTranslator(t);
  function errText(error) {
    const key = `error.${String(error?.code || 'network').toLowerCase()}`;
    return state.dict[key] || t('common.error');
  }
  async function loadLocale(locale) {
    if (!['uk', 'ru', 'en'].includes(locale)) locale = 'uk';
    try {
      const response = await fetch(`locales/${locale}.json?v=${VERSION}`);
      if (!response.ok) throw new Error();
      state.dict = await response.json();
      state.locale = locale;
      document.documentElement.lang = locale;
      storePref('pingup.locale', locale);
    } catch {
      if (locale !== 'en') return loadLocale('en');
      state.dict = { 'common.loading': 'Loading…', 'common.retry': 'Retry', 'error.network': 'Cannot reach the server. Try again.' };
    }
  }

  /* ---------- API ---------- */
  async function api(action, data = {}, options = {}) {
    const method = options.method || 'GET', url = new URL('api.php', location.href);
    url.searchParams.set('action', action);
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: options.signal };
    if (method === 'GET') {
      for (const [key, value] of Object.entries(data)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    } else {
      init.headers['X-CSRF-Token'] = state.csrf;
      if (data instanceof FormData) init.body = data;
      else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(data); }
    }
    let response, result;
    try { response = await fetch(url, init); result = await response.json(); }
    catch (error) { if (error.name === 'AbortError') throw error; throw { code: 'network', message: t('error.network') }; }
    if (!response.ok || !result.ok) {
      const error = result.error || { code: 'internal', message: t('common.error') };
      if (response.status === 401 && state.user && ['unauthorized', 'session_expired'].includes(error.code)) { clearSession(); renderAuth(); }
      throw error;
    }
    if (result.data?.csrf) state.csrf = result.data.csrf;
    return result.data;
  }
  const post = (action, data, options = {}) => api(action, data, { ...options, method: 'POST' });

  /* Upload with progress and cancellation. Files over one chunk use the resumable chunked endpoint. */
  function xhrPost(url, body, { onProgress, signal, contentType } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-CSRF-Token', state.csrf);
      xhr.setRequestHeader('Accept', 'application/json');
      if (contentType) xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded); };
      xhr.onload = () => {
        let result = null;
        try { result = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && result?.ok) resolve(result.data);
        else reject(result?.error || { code: xhr.status === 413 ? 'file_too_large' : 'upload_failed' });
      };
      xhr.onerror = () => reject({ code: 'network' });
      xhr.onabort = () => reject({ code: 'aborted', name: 'AbortError' });
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(body);
    });
  }
  async function uploadFile(file, purpose = 'file', { onProgress, signal } = {}) {
    const chunk = Number(state.config.chunk_bytes) || 8388608;
    const limit = purpose === 'file' ? Number(state.config.max_upload_bytes) : 0;
    if (limit && file.size > limit) {
      throw { code: !state.premium?.active && file.size <= Number(state.config.premium_upload_bytes) ? 'file_too_large_premium' : 'file_too_large' };
    }
    if (file.size <= chunk) {
      const form = new FormData();
      form.append('purpose', purpose);
      form.append('file', file);
      return xhrPost(new URL('api.php?action=files.upload', location.href), form, { onProgress: loaded => onProgress?.(Math.min(1, loaded / file.size)), signal });
    }
    const session = await post('files.upload_init', { name: file.name, size: file.size, purpose });
    let offset = 0;
    try {
      while (offset < file.size) {
        if (signal?.aborted) throw { code: 'aborted', name: 'AbortError' };
        const piece = file.slice(offset, offset + session.chunk_size);
        let attempt = 0, result;
        for (;;) {
          try {
            result = await xhrPost(new URL(`api.php?action=files.upload_chunk&upload_id=${session.upload_id}&offset=${offset}`, location.href), piece, { onProgress: loaded => onProgress?.(Math.min(1, (offset + loaded) / file.size)), signal, contentType: 'application/octet-stream' });
            break;
          } catch (error) {
            if (error.name === 'AbortError' || ++attempt > 3 || error.code !== 'network') throw error;
            await new Promise(r => setTimeout(r, 800 * attempt));
          }
        }
        offset = result.received;
        onProgress?.(offset / file.size);
      }
      return await post('files.upload_finish', { upload_id: session.upload_id });
    } catch (error) {
      post('files.upload_cancel', { upload_id: session.upload_id }).catch(() => {});
      throw error;
    }
  }

  /* ---------- Formatting helpers ---------- */
  const accentClass = value => { let h = 0; for (const c of String(value || 'p')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `c${(h % 6) + 1}`; };
  function initials(name) { const parts = String(name || 'P').trim().split(/\s+/); return ((parts[0]?.[0] || 'P') + (parts[1]?.[0] || '')).toUpperCase(); }
  function avatar(user, size = '', { online = false, effect = true } = {}) {
    const u = user || {};
    const fx = effect && u.premium && u.profile_effect && u.profile_effect !== 'none' ? ` effect-${esc(u.profile_effect)}` : '';
    return `<span class="avatar ${size} ${accentClass(u.username || u.name || u.id)}${fx}">${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="" loading="lazy" decoding="async">` : esc(initials(u.name || u.username))}${online && u.online ? '<i class="online"></i>' : ''}</span>`;
  }
  function badges(user) {
    if (!user) return '';
    return `${user.is_verified ? `<span class="verified" title="${esc(t('common.verified'))}">${icon('verified')}</span>` : ''}${user.premium ? `<span class="premium-badge" title="${esc(t('premium.badge'))}">${icon('crown')}</span>` : ''}`;
  }
  const peer = conv => conv?.participants?.find(u => Number(u.id) !== Number(state.user?.id)) || state.user;
  function convName(conv) { if (!conv) return ''; if (conv.type === 'saved') return t('nav.saved'); if (conv.type === 'direct') return peer(conv)?.name || conv.name; return conv.name; }
  function convAvatar(conv, size = '') {
    if (conv.type === 'direct') return avatar(peer(conv), size, { online: true });
    if (conv.type === 'saved') return `<span class="avatar saved ${size}">${icon('saved')}</span>`;
    return avatar({ name: conv.name, username: 'c' + conv.id, avatar_url: conv.avatar_url }, size);
  }
  const dateOf = value => new Date(typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) * 1000 : value);
  function timeFormat() { const f = state.settings.time_format; return f === '12' ? { hour12: true } : f === '24' ? { hour12: false } : {}; }
  const shortTime = value => dateOf(value).toLocaleTimeString(state.locale, { hour: '2-digit', minute: '2-digit', ...timeFormat() });
  function listTime(value) {
    const date = dateOf(value), now = new Date();
    if (date.toDateString() === now.toDateString()) return shortTime(value);
    if (now - date < 6 * 86400000) return date.toLocaleDateString(state.locale, { weekday: 'short' });
    return date.toLocaleDateString(state.locale, { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}) });
  }
  function dayLabel(value) {
    const date = dateOf(value), now = new Date(), yesterday = new Date(now - 86400000);
    if (date.toDateString() === now.toDateString()) return t('date.today');
    if (date.toDateString() === yesterday.toDateString()) return t('date.yesterday');
    return date.toLocaleDateString(state.locale, { day: 'numeric', month: 'long', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  }
  const longDate = value => dateOf(value).toLocaleDateString(state.locale, { day: 'numeric', month: 'long', year: 'numeric' });
  function lastSeen(user) {
    if (!user) return '';
    if (user.online) return t('common.online');
    if (user.last_seen_hidden || !user.last_seen) return t('presence.recently');
    const diff = Date.now() / 1000 - user.last_seen;
    if (diff < 3600) return t('presence.minutes', { count: Math.max(1, Math.round(diff / 60)) });
    if (dateOf(user.last_seen).toDateString() === new Date().toDateString()) return t('presence.today', { time: shortTime(user.last_seen) });
    return t('presence.date', { date: listTime(user.last_seen) });
  }
  function callLabel(call) {
    return t(call?.status === 'active' ? 'callchat.active' : call?.status === 'ringing' ? (call.incoming ? 'callchat.incoming' : 'callchat.outgoing') : call?.reason === 'completed' ? 'callchat.completed' : call?.reason === 'rejected' ? 'callchat.rejected' : call?.reason === 'cancelled' ? 'callchat.cancelled' : 'callchat.missed');
  }
  function messagePreview(m) {
    if (!m) return '';
    if (m.deleted || m.hidden) return t('message.deleted');
    if (m.call) return callLabel(m.call);
    if (m.kind === 'poll') return `📊 ${m.poll?.question || t('chat.poll')}`;
    if (m.kind === 'sticker') return `${m.sticker?.emoji || '✨'} ${t('chat.sticker')}`;
    if (m.kind === 'album') return `🖼 ${m.text || t('chat.album', { count: m.files?.length || 0 })}`;
    if (m.kind === 'voice') return `🎤 ${t('chat.voice')}`;
    if (m.file) {
      const kind = m.file.kind || '';
      const emoji = kind === 'image' ? '🖼' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📎';
      return `${emoji} ${m.text || m.file.name}`;
    }
    return String(m.text || '').replace(/\|\|(.+?)\|\|/g, '▒▒▒').replace(/[*_~`]{1,3}/g, '');
  }
  function fileSize(n) { return PU.fileSize(n); }
  function currentConversation() { return state.conversations.find(c => Number(c.id) === Number(state.active)); }
  function findConversation(id) { return state.conversations.find(c => Number(c.id) === Number(id)); }
  function empty(iconName, title, text = '', action = '') { return `<div class="empty"><span class="empty-icon">${icon(iconName)}</span><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`; }
  function toast(message, type = 'info', options) { if (type === 'error') window.PingUpExperience?.sound('error'); PU.toast(message, type, options); }
  function failed(error) { if (error?.name === 'AbortError' || error?.code === 'aborted') return; if (error?.code === 'premium_required' || error?.code === 'file_too_large_premium') return premiumNudge(error.code); toast(errText(error), 'error'); }
  function premiumNudge(code) {
    toast(errText({ code }), 'error', state.premium?.active ? {} : { action: t('premium.learn'), onAction: () => openSettings('premium') });
  }
  function unreadTotal() { return state.conversations.reduce((sum, c) => sum + (c.notification_mode === 'none' || c.archived ? 0 : Number(c.unread) || 0), 0); }

  /* ---------- Appearance ---------- */
  function applyTheme() {
    const resolved = state.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : state.theme;
    const root = document.documentElement;
    root.dataset.theme = resolved;
    $('meta[name="theme-color"]').content = resolved === 'light' ? '#eef0f8' : '#0a0c12';
  }
  function applyAppearance(settings = state.settings) {
    const root = document.documentElement, effective = settings.effective || settings;
    root.dataset.skin = effective.theme_name || 'pingup';
    root.dataset.wallpaper = effective.wallpaper || 'none';
    root.dataset.radius = settings.radius || 'default';
    root.dataset.density = settings.density || 'comfortable';
    root.dataset.listDensity = settings.list_density || 'default';
    root.dataset.bubbleStyle = settings.bubble_style || 'modern';
    root.style.setProperty('--font-size', `${Number(settings.font_size) || 15}px`);
    const accent = effective.accent;
    if (accent && accent !== '#a78bfa') root.style.setProperty('--accent', accent); else root.style.removeProperty('--accent');
  }

  /* ---------- Shell ---------- */
  function navCount(page) {
    if (page === 'chats') { const n = unreadTotal(); return n ? `<b class="nav-count">${n > 99 ? '99+' : n}</b>` : ''; }
    if (page === 'contacts' && state.contactRequests) return `<b class="nav-count">${state.contactRequests}</b>`;
    if (page === 'settings' && (state.feedbackUnread || state.admin?.feedback_unread)) return `<b class="nav-count">${state.feedbackUnread + (state.admin?.feedback_unread || 0)}</b>`;
    return '';
  }
  const navButton = page => `<button class="nav-item ${state.page === page ? 'active' : ''}" data-page="${page}" ${state.page === page ? 'aria-current="page"' : ''} aria-label="${esc(t(`nav.${page}`))}">${icon(page)}<span>${esc(t(`nav.${page}`))}</span>${navCount(page)}</button>`;
  function renderShell() {
    if (!state.user) return renderAuth();
    app.innerHTML = `<div class="app app-shell ${state.connected ? '' : 'offline'}"><nav class="rail" aria-label="${esc(t('nav.main'))}"><button class="brand-mark" data-page="chats" aria-label="PingUp"><img src="assets/logo.svg" alt=""></button>${PAGES.map(navButton).join('')}<span class="spacer"></span><button class="icon-btn" data-action="search" aria-label="${esc(t('search.title'))}">${icon('search')}</button><button data-action="my-profile" aria-label="${esc(t('profile.title'))}">${avatar(state.user, 'sm')}</button></nav><main class="main" id="main-content"></main><nav class="bottom-nav mobile-nav" aria-label="${esc(t('nav.main'))}"><i class="indicator"></i>${PAGES.map(navButton).join('')}</nav></div>`;
    renderPage();
  }
  function moveIndicator() {
    const index = PAGES.indexOf(state.page), indicator = $('.bottom-nav .indicator');
    if (indicator) indicator.style.transform = `translateX(calc(${Math.max(0, index)} * (100vw / 5)))`;
  }
  function renderPage() {
    const main = $('#main-content');
    if (!main) return;
    $$('.nav-item').forEach(el => { const active = el.dataset.page === state.page; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
    moveIndicator();
    const page = pages.get(state.page);
    if (!page) return;
    main.innerHTML = '';
    const el = document.createElement('section');
    el.className = `page page-enter ${state.page}-page`;
    el.dataset.pageName = state.page;
    main.append(el);
    page.render(el);
    emit('page', state.page);
  }
  let tabLayer = null;
  function setPage(page, { replace = false } = {}) {
    if (!state.user || !pages.has(page)) return;
    if (page === state.page && !replace) { pages.get(page).reselect?.(); return; }
    emit('leave-page', state.page);
    state.page = page;
    // Android Back from any other tab returns to Chats instead of leaving the app.
    if (page !== 'chats' && !tabLayer) tabLayer = PU.pushLayer(() => { tabLayer = null; if (state.page !== 'chats') { state.page = 'chats'; renderPage(); } }, 'tab');
    if (page === 'chats' && tabLayer) { const id = tabLayer; tabLayer = null; PU.closeLayer(id); }
    renderPage();
  }
  function registerPage(name, definition) { pages.set(name, definition); }
  function updateNavCounts() {
    $$('.nav-item').forEach(el => {
      const html = navCount(el.dataset.page), existing = $('.nav-count', el);
      if (!html) existing?.remove();
      else if (!existing) el.insertAdjacentHTML('beforeend', html);
      else existing.textContent = $('b', Object.assign(document.createElement('div'), { innerHTML: html })).textContent;
    });
    const total = unreadTotal();
    document.title = total ? `(${total}) PingUp` : 'PingUp — Just ping.';
    try { navigator.setAppBadge?.(total || undefined).catch?.(() => {}); if (!total) navigator.clearAppBadge?.().catch?.(() => {}); } catch { /* unsupported */ }
  }
  function setConnection(connected) {
    if (state.connected === connected) return;
    state.connected = connected;
    $('.app')?.classList.toggle('offline', !connected);
  }

  /* ---------- Chats page ---------- */
  function chatFilters() {
    const base = [['all', t('chat.all')], ['unread', t('chat.unread')], ['personal', t('chat.personal')], ['groups', t('chat.groups')], ['channels', t('chat.channels')]];
    return base.concat(state.folders.map(f => [`folder:${f.id}`, f.name]));
  }
  // Each list explains what belongs there and offers the next step instead of a bare "empty".
  function filterEmpty() {
    const f = state.showArchive ? 'archive' : state.filter.startsWith('folder:') ? 'folder' : state.filter;
    const btn = (attrs, iconName, label) => `<button class="btn primary" ${attrs}>${icon(iconName)}${esc(t(label))}</button>`;
    const variants = {
      all: ['chats', 'chat.empty_title', 'chat.empty_text', btn('data-action="create-menu"', 'plus', 'chat.create')],
      unread: ['checks', 'chat.empty_unread', 'chat.empty_unread_hint', `<button class="btn" data-filter="all">${esc(t('chat.all'))}</button>`],
      personal: ['chats', 'chat.empty_personal', 'chat.empty_personal_hint', btn('data-action="new-message"', 'edit', 'create.message')],
      groups: ['users', 'chat.empty_groups', 'chat.empty_groups_hint', btn('data-new-community="group"', 'plus', 'create.group')],
      channels: ['channels', 'chat.empty_channels', 'chat.empty_channels_hint', btn('data-page="channels"', 'search', 'chat.find_channels')],
      folder: ['folder', 'chat.empty_folder', 'chat.empty_folder_hint', btn('data-action="edit-folders"', 'edit', 'chat.edit_folder')],
      archive: ['archive', 'chat.empty_archive', 'chat.empty_archive_hint', ''],
    };
    const [iconName, title, text, action] = variants[f] || variants.all;
    return empty(iconName, t(title), t(text), action);
  }
  function matchesFilter(c) {
    const f = state.filter;
    if (f === 'unread') return c.unread > 0;
    if (f === 'personal') return ['direct', 'saved'].includes(c.type);
    if (f === 'groups') return c.type === 'group';
    if (f === 'channels') return c.type === 'channel';
    if (f.startsWith('folder:')) {
      const folder = state.folders.find(x => `folder:${x.id}` === f);
      if (!folder) return true;
      return folder.conversation_ids.includes(Number(c.id)) || folder.types.includes(c.type) || (folder.types.includes('unread') && c.unread > 0);
    }
    return true;
  }
  registerPage('chats', {
    render(el) {
      el.innerHTML = `<div class="split"><div class="list-pane"><header class="app-bar"><h1>${esc(t(state.showArchive ? 'chat.archive' : 'chat.title'))}</h1><span class="connection">${esc(t('chat.connection_offline'))}</span>${state.showArchive ? `<button class="icon-btn" data-action="close-archive" aria-label="${esc(t('common.back'))}">${icon('back')}</button>` : ''}<button class="icon-btn" data-action="search" aria-label="${esc(t('search.title'))}">${icon('search')}</button><button class="icon-btn desktop-only" data-action="create-menu" aria-label="${esc(t('chat.create'))}">${icon('plus')}</button></header><label class="searchbar">${icon('search')}<input id="chat-search" type="search" autocomplete="off" placeholder="${esc(t('chat.search'))}" value="${esc(state.chatQuery)}"></label><div class="chips" role="tablist">${chatFilters().map(([id, label]) => `<button class="chip ${state.filter === id ? 'active' : ''}" role="tab" aria-selected="${state.filter === id}" data-filter="${esc(id)}">${esc(label)}</button>`).join('')}</div><div class="scroller" id="chat-scroller"><div class="chat-list conversation-list" role="list"></div></div><button class="fab mobile-only" data-action="create-menu" aria-label="${esc(t('chat.create'))}">${icon('plus')}</button></div><div class="detail-pane" id="detail-pane"><div class="chat-placeholder"><span class="logo-orb"><img src="assets/logo.svg" alt=""></span><h3>${esc(t('chat.choose_title'))}</h3><p>${esc(t('chat.choose_text'))}</p></div></div></div>`;
      const scroller = $('#chat-scroller', el);
      PU.pullToRefresh(scroller, () => poll());
      updateConversationList(true);
      scroller.scrollTop = state.scroll.get('list:chats') || 0;
      scroller.addEventListener('scroll', () => state.scroll.set('list:chats', scroller.scrollTop), { passive: true });
      emit('chats-rendered', el);
    },
    reselect() { const s = $('#chat-scroller'); if (s) s.scrollTo({ top: 0, behavior: PU.reducedMotion() ? 'auto' : 'smooth' }); },
  });
  function rowTicks(conv) {
    const m = conv.last_message;
    if (!m || Number(m.sender_id) !== Number(state.user.id) || conv.type === 'channel' || m.call) return '';
    const status = window.PingUpChat?.deliveryStatus(m, conv) || 'sent';
    return `<span class="ticks ${status}">${icon(status === 'sent' ? 'check' : 'checks')}</span>`;
  }
  function rowHTML(conv) {
    const m = conv.last_message, mine = m && Number(m.sender_id) === Number(state.user.id);
    const typing = state.typing.get(Number(conv.id));
    const draft = Number(conv.id) !== Number(state.active) && (state.drafts.get(Number(conv.id))?.text || conv.draft);
    let preview;
    if (typing?.length) preview = `<span class="typing">${esc(typingText(typing, conv))}</span>`;
    else if (draft) preview = `<span class="draft">${esc(t('chat.draft'))}:</span> ${esc(draft)}`;
    else preview = `${m && conv.type === 'group' && !mine && !m.call ? `<b>${esc(conv.participants?.find(u => u.id === m.sender_id)?.name?.split(' ')[0] || '')}:</b> ` : mine && conv.type !== 'channel' && !m.call ? `<b>${esc(t('common.you'))}:</b> ` : ''}${esc(messagePreview(m) || (conv.type === 'channel' ? conv.description : '') || t('chat.no_messages'))}`;
    const muted = conv.notification_mode === 'none';
    return `${convAvatar(conv)}<span class="chat-row-body"><span class="chat-row-top"><span class="chat-row-title"><span>${esc(convName(conv))}</span>${conv.type === 'direct' ? badges(peer(conv)) : ''}${conv.type === 'channel' ? icon('channels', 'mute-icon') : ''}${muted ? `<span class="mute-icon">${icon('bellOff')}</span>` : ''}</span>${rowTicks(conv)}<time>${m ? esc(listTime(m.created_at)) : ''}</time></span><span class="chat-row-bottom"><span class="chat-row-preview">${preview}</span>${conv.unread ? `<b class="badge ${muted ? 'muted-badge' : ''}">${conv.unread > 999 ? '999+' : conv.unread}</b>` : conv.pinned ? `<span class="pin-icon">${icon('pin')}</span>` : ''}</span></span>`;
  }
  function typingText(people, conv) {
    const first = people[0];
    const kind = first.kind === 'recording' ? 'chat.recording_voice' : first.kind === 'uploading' ? 'chat.uploading_file' : 'chat.typing';
    if (conv?.type === 'direct') return t(`${kind}_direct`);
    return people.length > 1 ? t('chat.typing_many', { name: first.name.split(' ')[0], count: people.length }) : t(kind, { name: first.name.split(' ')[0] });
  }
  function updateConversationList(initial = false) {
    const list = $('#chat-scroller .conversation-list');
    if (!list) return;
    const query = state.chatQuery.trim().toLocaleLowerCase();
    const archived = state.conversations.filter(c => c.archived);
    const visible = state.conversations.filter(c => (state.showArchive ? c.archived : !c.archived) && matchesFilter(c) && (!query || convName(c).toLocaleLowerCase().includes(query) || (c.slug || '').includes(query)));
    const rows = [];
    if (!state.showArchive && archived.length && !query && state.filter === 'all') rows.push({ key: 'archive', html: `<span class="avatar">${icon('archive')}</span><span class="chat-row-body"><span class="chat-row-top"><span class="chat-row-title"><span>${esc(t('chat.archive'))}</span></span></span><span class="chat-row-bottom"><span class="chat-row-preview">${esc(archived.slice(0, 3).map(convName).join(', '))}</span>${archived.some(c => c.unread) ? `<b class="badge muted-badge">${archived.reduce((n, c) => n + (c.unread || 0), 0)}</b>` : ''}</span></span>`, cls: 'archive-row', attrs: { action: 'open-archive' } });
    for (const conv of visible) rows.push({ key: String(conv.id), html: rowHTML(conv), cls: Number(conv.id) === Number(state.active) ? 'active' : '', attrs: { openConversation: String(conv.id) } });
    if (!rows.length) {
      const content = query ? empty('search', t('chat.no_results'), t('chat.search_global_hint'), `<button class="btn primary" data-action="search-global" data-q="${esc(state.chatQuery)}">${icon('search')}${esc(t('search.title'))}</button>`) : filterEmpty();
      if (list.dataset.empty !== content) { list.innerHTML = content; list.dataset.empty = content; }
      return;
    }
    if (list.dataset.empty) { list.replaceChildren(); delete list.dataset.empty; }
    // Keyed reconciliation: rows keep their DOM (and loaded avatars) across polling.
    const existing = new Map([...list.children].map(row => [row.dataset.key, row]));
    let cursor = list.firstElementChild;
    const seen = new Set();
    for (const item of rows) {
      let row = existing.get(item.key);
      const fresh = !row;
      if (!row) {
        row = document.createElement('button');
        row.type = 'button';
        row.dataset.key = item.key;
        row.setAttribute('role', 'listitem');
      }
      for (const [k, v] of Object.entries(item.attrs)) row.dataset[k] = v;
      if (row.dataset.html !== item.html) {
        const avatarEl = $('.avatar', row);
        row.innerHTML = item.html;
        const nextAvatar = $('.avatar', row);
        if (avatarEl && nextAvatar && avatarEl.outerHTML === nextAvatar.outerHTML) nextAvatar.replaceWith(avatarEl);
        row.dataset.html = item.html;
      }
      row.className = `chat-row conversation-row ${item.cls}`;
      if (fresh && !initial) PU.animateIn(row);
      if (row !== cursor) list.insertBefore(row, cursor);
      cursor = row.nextElementSibling;
      seen.add(item.key);
    }
    for (const [key, row] of existing) if (!seen.has(key)) row.remove();
  }
  function retainConversation(conv) {
    const index = state.conversations.findIndex(c => Number(c.id) === Number(conv.id));
    if (index >= 0) state.conversations[index] = { ...state.conversations[index], ...conv };
    else state.conversations.unshift(conv);
    updateConversationList();
    updateNavCounts();
    emit('conversations');
    return findConversation(conv.id);
  }
  function removeConversation(id) {
    state.conversations = state.conversations.filter(c => Number(c.id) !== Number(id));
    state.messages.delete(Number(id));
    state.changeCursors.delete(Number(id));
    if (Number(state.active) === Number(id)) window.PingUpChat?.close();
    updateConversationList();
    updateNavCounts();
    emit('conversations');
  }

  /* Universal "+" — one entry point for new message / group / channel. */
  function createMenu(anchor) {
    const items = [
      { id: 'create-message', icon: 'chats', label: t('create.message'), hint: t('create.message_hint'), action: () => window.PingUpPages?.newMessage() },
      { id: 'create-group', icon: 'users', label: t('create.group'), hint: t('create.group_hint'), action: () => window.PingUpPages?.newCommunity('group') },
      { id: 'create-channel', icon: 'channels', label: t('create.channel'), hint: t('create.channel_hint'), action: () => window.PingUpPages?.newCommunity('channel') },
    ];
    const fab = anchor?.classList.contains('fab') ? anchor : null;
    fab?.classList.add('open');
    const handle = PU.menu(items, PU.isMobile() || !anchor ? { title: t('chat.create') } : { anchor });
    const observer = new MutationObserver(() => { if (!handle.el.isConnected) { fab?.classList.remove('open'); observer.disconnect(); } });
    observer.observe(document.body, { childList: true });
  }

  /* ---------- Sync loop ---------- */
  function schedulePolling() {
    clearTimeout(state.timer);
    if (!state.user) return;
    state.timer = setTimeout(async () => { await poll(); schedulePolling(); }, document.hidden ? 15000 : 2000);
  }
  function stopPolling() { clearTimeout(state.timer); state.timer = null; state.syncBusy = false; }
  async function poll() {
    if (!state.user || state.syncBusy) return;
    state.syncBusy = true;
    const active = state.active;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 18000);
    try {
      const data = await api('sync', {
        conversation_id: active || undefined,
        after_id: active ? window.PingUpChat?.maxMessageId(active) : undefined,
        after_event_id: state.eventCursor,
        after_change_seq: active ? state.changeCursors.get(Number(active)) || 0 : undefined,
      }, { signal: controller.signal });
      if (!state.user) return;
      setConnection(true);
      state.lastSync = Date.now();
      mergeConversations(data.conversations || []);
      if (data.user) state.user = { ...state.user, ...data.user };
      if (active && Number(state.active) === Number(active)) {
        window.PingUpChat?.applySync(data);
        state.typing.set(Number(active), data.typing || []);
      }
      updateConversationList();
      updateNavCounts();
      state.eventCursor = data.event_cursor ?? state.eventCursor;
      if (data.notification_settings) { window.PingUpExperience?.updateSettings(data.notification_settings); }
      await window.PingUpExperience?.events(data.events || []);
      handleEvents(data.events || []);
      emit('sync', data);
    } catch (error) {
      if (state.user && error.code === 'conversation_not_found' && active && Number(state.active) === Number(active)) {
        removeConversation(active);
        toast(t('channel.access_lost'));
      } else if (state.user && (error.code === 'network' || error.name === 'AbortError')) setConnection(false);
    } finally {
      clearTimeout(timeout);
      state.syncBusy = false;
    }
  }
  function mergeConversations(list) {
    const previous = new Map(state.conversations.map(c => [Number(c.id), c]));
    state.conversations = list.map(c => {
      const old = previous.get(Number(c.id));
      // A locally pending read must not be overwritten by an older server snapshot.
      if (old && Number(old.id) === Number(state.active) && old.unread === 0 && c.unread > 0 && document.hasFocus()) return { ...c, unread: old.unread };
      return c;
    });
    if (state.active && !state.conversations.some(c => Number(c.id) === Number(state.active))) {
      const old = previous.get(Number(state.active));
      if (old) state.conversations.unshift(old);
    }
    emit('conversations');
  }
  function handleEvents(events) {
    for (const event of events) {
      if (event.kind === 'contact') api('contacts.list').then(data => { state.contactRequests = data.incoming.length; state.contacts = data.contacts; updateNavCounts(); emit('contacts-changed', data); }).catch(() => {});
      if (event.kind === 'feedback') { state.feedbackUnread++; updateNavCounts(); emit('feedback-changed', event); }
    }
  }

  /* ---------- Profile / search shortcuts implemented in pages.js ---------- */
  const openProfile = id => window.PingUpPages?.profile(id);
  const openSettings = section => { setPage('settings'); if (section) setTimeout(() => window.PingUpPages?.openSection(section), 0); };

  /* ---------- Authentication ---------- */
  function renderAuth() {
    state.active = null;
    const register = state.authMode === 'register', recover = state.authMode === 'recover';
    const languages = `<div class="lang-switch">${['uk', 'ru', 'en'].map(lang => `<button class="${state.locale === lang ? 'active' : ''}" data-language="${lang}">${lang === 'uk' ? 'UA' : lang.toUpperCase()}</button>`).join('')}</div>`;
    const form = recover
      ? `<form class="form" id="recover-form"><p class="lead">${esc(t('auth.recover_hint'))}</p><label class="field"><span>${esc(t('auth.recover_identifier'))}</span><input name="identifier" required maxlength="254" autocomplete="username"></label><div class="recover-step" hidden><label class="field"><span>${esc(t('email.code'))}</span><input name="code" inputmode="numeric" maxlength="6" class="code-input" autocomplete="one-time-code"></label><label class="field"><span>${esc(t('auth.new_password'))}</span><input name="new_password" type="password" minlength="10" maxlength="128" autocomplete="new-password"></label></div><div class="form-error" role="alert" hidden></div><button class="btn primary block" type="submit">${esc(t('auth.recover_send'))}</button><button type="button" class="text-btn" data-auth-mode="login">${esc(t('common.back'))}</button></form>`
      : `<div class="segmented"><button data-auth-mode="login" class="${register ? '' : 'active'}">${esc(t('auth.login'))}</button><button data-auth-mode="register" class="${register ? 'active' : ''}" ${state.config.registration_enabled === false ? 'disabled' : ''}>${esc(t('auth.register'))}</button></div><form class="form" id="auth-form">${register ? `<label class="field"><span>${esc(t('auth.name'))}</span><input name="name" required maxlength="60" autocomplete="name" placeholder="${esc(t('auth.name_hint'))}"></label><label class="field"><span>${esc(t('auth.username'))}</span><div class="input-prefix"><i>@</i><input name="username" required minlength="3" maxlength="24" pattern="[A-Za-z][A-Za-z0-9_]{2,23}" autocomplete="username" placeholder="${esc(t('auth.username_hint'))}"></div></label>` : `<label class="field"><span>${esc(t('auth.identifier'))}</span><input name="identifier" required maxlength="254" autocomplete="username" placeholder="${esc(t('auth.identifier_hint'))}"></label>`}<label class="field"><span>${esc(t('auth.password'))}</span><input name="password" type="password" required ${register ? 'minlength="10"' : ''} maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}"></label>${register && state.config.invite_required ? `<label class="field"><span>${esc(t('auth.invite'))}</span><input name="invite_code" required maxlength="200" autocomplete="off"></label>` : ''}<div class="form-error" role="alert" hidden></div><button class="btn primary block" type="submit">${esc(t(register ? 'auth.submit_register' : 'auth.submit_login'))}</button>${!register && state.config.recovery_enabled ? `<button type="button" class="text-btn" data-auth-mode="recover">${esc(t('auth.forgot'))}</button>` : ''}</form>`;
    app.innerHTML = `<div class="auth"><section class="auth-story"><span class="brand"><img src="assets/logo.svg" alt="">Ping<b>Up</b></span><h2>${t('auth.story_title')}</h2><div class="auth-features">${[['chats', 'auth.feature_chat'], ['shield', 'auth.feature_privacy'], ['sparkles', 'auth.feature_style']].map(([i, k]) => `<div>${icon(i)}<span>${esc(t(k))}</span></div>`).join('')}</div></section><section class="auth-panel"><div class="auth-card page-enter"><div class="auth-top"><span class="brand"><img src="assets/logo.svg" alt="">Ping<b>Up</b></span>${languages}</div><h1>${esc(t(recover ? 'auth.recover_title' : register ? 'auth.register' : 'auth.welcome'))}</h1>${recover ? '' : `<p class="lead">${esc(t('auth.subtitle'))}</p>`}${form}<p class="auth-note">${icon('shield')}${esc(t('auth.privacy'))}</p></div></section></div>`;
  }
  function showFormError(form, message) { const el = $('.form-error', form); if (el) { el.hidden = !message; el.textContent = message; } }
  async function submitAuth(form) {
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form));
    if (data.identifier) data.identifier = data.identifier.trim();
    const button = $('[type="submit"]', form);
    button.classList.add('loading');
    showFormError(form, '');
    try {
      await post(`auth.${state.authMode}`, { ...data, locale: state.locale });
      await bootstrap();
    } catch (error) { showFormError(form, errText(error)); }
    finally { button.classList.remove('loading'); }
  }
  async function submitRecover(form) {
    const data = Object.fromEntries(new FormData(form)), step = $('.recover-step', form), button = $('[type="submit"]', form);
    button.classList.add('loading');
    showFormError(form, '');
    try {
      if (step.hidden) {
        await post('auth.recover_request', { identifier: data.identifier.trim() });
        step.hidden = false;
        button.textContent = t('auth.recover_confirm');
        toast(t('auth.recover_sent'), 'success');
      } else {
        await post('auth.recover_confirm', { identifier: data.identifier.trim(), code: data.code.trim(), new_password: data.new_password });
        toast(t('auth.recover_done'), 'success');
        state.authMode = 'login';
        renderAuth();
      }
    } catch (error) { showFormError(form, errText(error)); }
    finally { button.classList.remove('loading'); }
  }

  /* ---------- Session ---------- */
  function clearSession() {
    window.PingUpExperience?.stop();
    stopPolling();
    window.PingUpChat?.reset();
    window.PingUpCalls?.stop();
    Object.assign(state, { user: null, active: null, conversations: [], contacts: [], folders: [], typing: new Map(), page: 'chats', showArchive: false });
    state.messages.clear(); state.drafts.clear(); state.changeCursors.clear(); state.scroll.clear();
    document.title = 'PingUp — Just ping.';
    $$('.pu-sheet-root,.pu-popover-root,.pu-viewer').forEach(el => el.remove());
  }
  async function logout() {
    if (!await PU.confirm({ title: t('settings.logout'), text: t('settings.logout_confirm'), confirm: t('settings.logout'), danger: true })) return;
    try {
      await window.PingUpExperience?.disablePush(true);
      await window.PingUpCalls?.stop();
      const data = await post('auth.logout', {});
      clearSession();
      state.csrf = data?.csrf || '';
      state.authMode = 'login';
      await bootstrap();
    } catch (error) { failed(error); }
  }
  async function changeLocale(locale) {
    state.hasLocale = true;
    await loadLocale(locale);
    if (state.user) { post('profile.update', { locale: state.locale }).catch(() => {}); renderShell(); window.PingUpChat?.rerender(); }
    else renderAuth();
  }
  function changeTheme(theme) {
    state.hasTheme = true;
    state.theme = theme;
    storePref('pingup.theme', theme);
    if (state.user) post('profile.update', { theme }).catch(() => {});
    applyTheme();
    emit('theme');
  }

  /* ---------- Global events ---------- */
  document.addEventListener('click', async event => {
    const el = event.target.closest('button,[data-page],[data-open-conversation],[data-action]');
    if (!el || el.disabled) return;
    const d = el.dataset;
    if (d.page && !el.closest('.pu-sheet-root')) { setPage(d.page); return; }
    if (d.authMode) { state.authMode = d.authMode; renderAuth(); return; }
    if (d.language && !state.user) { await changeLocale(d.language); return; }
    if (d.openConversation) { window.PingUpChat?.open(Number(d.openConversation)); return; }
    if (d.filter) { state.filter = d.filter; $$('[data-filter]').forEach(b => { b.classList.toggle('active', b.dataset.filter === state.filter); b.setAttribute('aria-selected', String(b.dataset.filter === state.filter)); }); updateConversationList(true); return; }
    if (d.profile) { openProfile(Number(d.profile)); return; }
    switch (d.action) {
      case 'create-menu': createMenu(el); break;
      case 'search': window.PingUpPages?.search(); break;
      case 'search-global': window.PingUpPages?.search(d.q || ''); break;
      case 'my-profile': openSettings('profile'); break;
      case 'new-message': window.PingUpPages?.newMessage(); break;
      case 'edit-folders': openSettings('folders'); break;
      case 'open-archive': state.showArchive = true; renderPage(); break;
      case 'close-archive': state.showArchive = false; renderPage(); break;
      case 'retry-bootstrap': bootstrap(); break;
      case 'logout': logout(); break;
    }
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form.id === 'auth-form') { event.preventDefault(); submitAuth(form); }
    if (form.id === 'recover-form') { event.preventDefault(); submitRecover(form); }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'chat-search') { state.chatQuery = event.target.value; updateConversationList(true); }
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && state.user) { event.preventDefault(); window.PingUpPages?.search(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (!state.user) return;
    clearTimeout(state.timer);
    if (!document.hidden) { poll().finally(schedulePolling); emit('visible'); } else schedulePolling();
  });
  window.addEventListener('focus', () => { if (state.user) { poll(); emit('visible'); } });
  window.addEventListener('online', () => { if (state.user) { poll(); window.PingUpChat?.retryFailed(); } else bootstrap(); });
  window.addEventListener('offline', () => setConnection(false));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.theme === 'system') applyTheme(); });
  window.addEventListener('resize', PU.debounce(moveIndicator, 100));

  /* ---------- Bootstrap ---------- */
  async function bootstrap() {
    try {
      const data = await api('bootstrap');
      state.csrf = data.csrf;
      state.user = data.user;
      state.config = data.config || {};
      setConnection(true);
      if (!state.user) { renderAuth(); return; }
      Object.assign(state, {
        conversations: data.conversations || [], contacts: data.contacts || [], contactRequests: data.contact_requests || 0,
        eventCursor: data.event_cursor || 0, privacy: data.privacy || {}, premium: data.premium || {}, folders: data.folders || [],
        feedbackUnread: data.feedback_unread || 0, admin: data.admin || null, settings: data.notification_settings || {},
      });
      if (!state.hasLocale && state.user.locale && state.user.locale !== state.locale) await loadLocale(state.user.locale);
      if (!state.hasTheme && state.user.theme) { state.theme = state.user.theme; applyTheme(); }
      applyAppearance(state.settings);
      renderShell();
      updateNavCounts();
      await window.PingUpExperience?.init(data);
      window.PingUpCalls?.init({ api, t, getUser: () => state.user, notify: toast, iceServers: state.config.ice_servers });
      schedulePolling();
      emit('ready', data);
      const params = new URLSearchParams(location.search);
      if (params.has('feedback')) window.PingUpPages?.openTicket(Number(params.get('feedback')));
      if (params.has('contacts')) setPage('contacts');
      if (params.has('join')) { window.PingUpPages?.joinSlug(params.get('join')); params.delete('join'); history.replaceState(history.state, '', `${location.pathname}${params.size ? '?' + params : ''}`); }
    } catch (error) {
      app.innerHTML = `<div class="boot-screen"><img src="assets/logo.svg" alt="PingUp" width="64" height="74"><h2>${esc(t('auth.server_unavailable'))}</h2><p class="muted">${esc(errText(error))}</p><button class="btn primary" data-action="retry-bootstrap">${icon('refresh')}${esc(t('common.retry'))}</button></div>`;
    }
  }

  window.PingUp = {
    VERSION, state, t, api, post, uploadFile, errText, toast, failed, premiumNudge, on, emit,
    avatar, badges, peer, convName, convAvatar, shortTime, listTime, dayLabel, longDate, lastSeen, callLabel, messagePreview, fileSize, typingText,
    currentConversation, findConversation, retainConversation, removeConversation, updateConversationList, updateNavCounts, empty,
    registerPage, setPage, renderPage, renderShell, poll, openProfile, openSettings, applyTheme, applyAppearance, changeLocale, changeTheme, logout, createMenu,
    readPref, storePref,
  };

  window.PingUpExperience?.configure({
    api, t, toast,
    openChat: id => window.PingUpChat?.open(id),
    joinInvite: token => window.PingUpPages?.joinInvite(token),
    restoreQueued: message => window.PingUpChat?.restoreQueued(message),
    retryQueued: () => window.PingUpChat?.retryFailed(),
    activeChat: () => state.active,
    hasChat: id => state.conversations.some(c => Number(c.id) === Number(id)),
    getChat: id => findConversation(id),
    onSettings: settings => { state.settings = settings; applyAppearance(settings); emit('settings', settings); },
    reconnect: () => { if (state.user) poll(); },
    offline: () => setConnection(false),
    refreshCalls: () => window.PingUpCalls?.refresh(),
    openFeedback: id => window.PingUpPages?.openTicket(id),
    openContacts: () => setPage('contacts'),
  });

  applyTheme();
  // Deferred feature scripts (chat.js, pages.js) register before the first render.
  document.addEventListener('DOMContentLoaded', () => loadLocale(state.locale).then(bootstrap));
})();
