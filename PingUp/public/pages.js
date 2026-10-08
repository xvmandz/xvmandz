'use strict';
/* PingUp pages: channels, contacts, calls, search, profiles, communities (info/management/analytics), comment threads. */
(() => {
  const { $, $$, esc, icon } = PU;
  const P = window.PingUp, state = P.state, t = P.t;
  const Pages = window.PingUpPages = window.PingUpPages || {};
  const PRESETS = ['classic', 'minimal', 'dark_neon', 'glass', 'gradient', 'community', 'gaming', 'business'];
  const CATEGORIES = ['news', 'tech', 'gaming', 'music', 'education', 'business', 'community', 'art', 'sport', 'other'];

  /* Sub-pages slide over the current tab and close with Back. */
  function subpage(title, { actions = '', className = '' } = {}) {
    const main = $('#main-content');
    const el = document.createElement('section');
    el.className = `subpage ${className}`;
    el.innerHTML = `<header class="app-bar"><button class="icon-btn" data-subpage-back aria-label="${esc(t('common.back'))}">${icon('back')}</button><h1>${esc(title)}</h1>${actions}</header><div class="scroller"><div class="page-content page-inner"></div></div>`;
    main.append(el);
    requestAnimationFrame(() => el.classList.add('open'));
    let closed = false;
    const layer = PU.pushLayer(() => { closed = true; el.classList.remove('open'); setTimeout(() => el.remove(), PU.reducedMotion() ? 0 : 260); }, 'subpage');
    const api = { el, body: $('.page-content', el), close: () => !closed && PU.closeLayer(layer), get closed() { return closed; }, setTitle: text => { $('h1', el).textContent = text; } };
    el.addEventListener('click', event => { if (event.target.closest('[data-subpage-back]')) api.close(); });
    return api;
  }
  Pages.subpage = subpage;
  const loading = '<div class="spinner"></div>';
  const errorBlock = error => `<p class="form-error pad">${esc(P.errText(error))}</p>`;
  function userRow(u, extra = '', attrs = `data-profile="${u.id}"`) {
    return `<button class="list-item" ${attrs}>${P.avatar(u, '', { online: true })}<span class="li-body"><strong>${esc(u.name)}${P.badges(u)}</strong><small>@${esc(u.username)} · ${esc(P.lastSeen(u))}</small></span>${extra}</button>`;
  }
  function communityRow(c) {
    return `<div class="list-item"><button class="list-item" style="padding:0" data-community-info="${c.id}" data-public="1">${P.avatar({ name: c.name, username: 'c' + c.id, avatar_url: c.avatar_url }, '')}<span class="li-body"><strong>${esc(c.name)}</strong><small>${c.slug ? '@' + esc(c.slug) + ' · ' : ''}${c.member_count !== null ? esc(t(c.type === 'group' ? 'chat.participants' : 'channel.subscribers', { count: c.member_count })) : ''}</small>${c.tagline || c.description ? `<small>${esc(c.tagline || c.description)}</small>` : ''}</span></button><button class="btn small ${c.joined ? '' : 'primary'}" data-join-public="${c.id}" data-joined="${c.joined ? 1 : 0}">${esc(t(c.joined ? 'channel.open' : c.type === 'group' ? 'group.join' : 'channel.join'))}</button></div>`;
  }

  /* ---------- Channels tab ---------- */
  let discoverTimer = null, discoverController = null;
  P.registerPage('channels', {
    render(el) {
      const mine = state.conversations.filter(c => c.type === 'channel');
      el.innerHTML = `<header class="app-bar"><h1>${esc(t('nav.channels'))}</h1><button class="icon-btn" data-action="search" aria-label="${esc(t('search.title'))}">${icon('search')}</button><button class="icon-btn" data-new-community="channel" aria-label="${esc(t('create.channel'))}">${icon('plus')}</button></header><label class="searchbar">${icon('search')}<input id="discover-search" type="search" autocomplete="off" placeholder="${esc(t('channel.discover_search'))}"></label><div class="chips">${['all', ...CATEGORIES].map(c => `<button class="chip ${c === 'all' ? 'active' : ''}" data-discover-category="${c}">${esc(t(c === 'all' ? 'chat.all' : `category.${c}`))}</button>`).join('')}</div><div class="scroller"><div class="page-inner"><div id="discover-results"></div><div class="group-title">${esc(t('channel.my_channels'))}</div><div class="chat-list" id="my-channels">${mine.length ? '' : P.empty('channels', t('channel.none_yet'), t('channel.none_hint'), `<button class="btn primary" data-new-community="channel">${icon('plus')}${esc(t('create.channel'))}</button>`)}</div></div></div>`;
      const listEl = $('#my-channels', el);
      for (const c of mine) listEl.insertAdjacentHTML('beforeend', `<button class="chat-row" data-open-conversation="${c.id}">${P.convAvatar(c)}<span class="chat-row-body"><span class="chat-row-top"><span class="chat-row-title"><span>${esc(c.name)}</span></span><time>${c.last_message ? esc(P.listTime(c.last_message.created_at)) : ''}</time></span><span class="chat-row-bottom"><span class="chat-row-preview">${esc(P.messagePreview(c.last_message) || c.description || '')}</span>${c.unread ? `<b class="badge ${c.notification_mode === 'none' ? 'muted-badge' : ''}">${c.unread}</b>` : ''}</span></span></button>`);
      discover('');
    },
  });
  function discover(q, category = 'all') {
    clearTimeout(discoverTimer);
    discoverController?.abort();
    discoverTimer = setTimeout(async () => {
      const target = $('#discover-results');
      if (!target) return;
      if (q.trim().length < 2 && category === 'all') { target.innerHTML = `<p class="hint">${esc(t('channel.discover_hint'))}</p>`; return; }
      discoverController = new AbortController();
      target.innerHTML = loading;
      try {
        const params = { q: q.trim(), category: category === 'all' ? undefined : category };
        const [channels, groups] = await Promise.all([
          P.api('search.global', { ...params, type: 'channels' }, { signal: discoverController.signal }),
          P.api('search.global', { ...params, type: 'groups' }, { signal: discoverController.signal }),
        ]);
        const found = [...channels.channels.map(c => ({ ...c, type: 'channel' })), ...groups.groups.map(c => ({ ...c, type: 'group' }))];
        target.innerHTML = `<div class="group-title">${esc(t('channel.discover'))}</div><div class="group-card list">${found.length ? found.map(communityRow).join('') : `<p class="hint">${esc(t('channel.empty'))}</p>`}</div>`;
      } catch (error) { if (error.name !== 'AbortError') target.innerHTML = errorBlock(error); }
    }, 300);
  }

  /* ---------- Contacts tab ---------- */
  let contactsTab = 'contacts', contactsData = null;
  P.registerPage('contacts', {
    render(el) {
      el.innerHTML = `<header class="app-bar"><h1>${esc(t('contacts.title'))}</h1><button class="icon-btn" data-add-contact aria-label="${esc(t('contacts.add'))}">${icon('userPlus')}</button></header><label class="searchbar">${icon('search')}<input id="contacts-search" type="search" autocomplete="off" placeholder="${esc(t('contacts.search'))}"></label><div class="chips">${['contacts', 'requests', 'blocked'].map(tab => `<button class="chip ${contactsTab === tab ? 'active' : ''}" data-contacts-tab="${tab}">${esc(t(`contacts.tab_${tab}`))}${tab === 'requests' && state.contactRequests ? ` <b class="badge">${state.contactRequests}</b>` : ''}</button>`).join('')}</div><div class="scroller"><div class="page-inner" id="contacts-body">${loading}</div></div>`;
      loadContacts();
    },
  });
  async function loadContacts() {
    try {
      contactsData = await P.api('contacts.list');
      state.contacts = contactsData.contacts;
      state.contactRequests = contactsData.incoming.length;
      P.updateNavCounts();
      renderContacts();
    } catch (error) { const b = $('#contacts-body'); if (b) b.innerHTML = errorBlock(error); }
  }
  function renderContacts() {
    const body = $('#contacts-body');
    if (!body || !contactsData) return;
    const q = ($('#contacts-search')?.value || '').toLocaleLowerCase();
    const match = u => !q || `${u.name} ${u.username}`.toLocaleLowerCase().includes(q);
    if (contactsTab === 'contacts') {
      const list = contactsData.contacts.filter(match);
      body.innerHTML = list.length ? `<div class="group-card list">${list.map(u => `<div class="list-item">${userRow(u).replace('class="list-item"', 'class="list-item" style="padding:0;flex:1"')}<button class="icon-btn" data-direct-user="${u.id}" aria-label="${esc(t('contacts.write'))}">${icon('chats')}</button><button class="icon-btn" data-call-user="${u.id}" aria-label="${esc(t('chat.call'))}">${icon('phone')}</button></div>`).join('')}</div>` : P.empty('contacts', t(q ? 'contacts.no_results' : 'contacts.empty_title'), t('contacts.empty_text'), `<button class="btn primary" data-add-contact>${icon('userPlus')}${esc(t('contacts.add'))}</button>`);
    } else if (contactsTab === 'requests') {
      const incoming = contactsData.incoming.filter(match), outgoing = contactsData.outgoing.filter(match);
      body.innerHTML = `${incoming.length ? `<div class="group-title">${esc(t('contacts.incoming'))}</div><div class="group-card list">${incoming.map(u => `<div class="list-item">${userRow(u).replace('class="list-item"', 'class="list-item" style="padding:0;flex:1"')}<button class="btn small primary" data-contact-accept="${u.id}">${esc(t('contacts.accept'))}</button><button class="icon-btn" data-contact-decline="${u.id}" aria-label="${esc(t('contacts.decline'))}">${icon('close')}</button></div>`).join('')}</div>` : ''}${outgoing.length ? `<div class="group-title">${esc(t('contacts.outgoing'))}</div><div class="group-card list">${outgoing.map(u => `<div class="list-item">${userRow(u).replace('class="list-item"', 'class="list-item" style="padding:0;flex:1"')}<button class="btn small" data-contact-cancel="${u.id}">${esc(t('contacts.cancel_request'))}</button></div>`).join('')}</div>` : ''}${!incoming.length && !outgoing.length ? P.empty('userPlus', t('contacts.no_requests'), t('contacts.no_requests_hint')) : ''}`;
    } else {
      const list = contactsData.blocked.filter(match);
      body.innerHTML = list.length ? `<div class="group-card list">${list.map(u => `<div class="list-item">${userRow(u).replace('class="list-item"', 'class="list-item" style="padding:0;flex:1"')}<button class="btn small" data-unblock="${u.id}">${esc(t('contacts.unblock'))}</button></div>`).join('')}</div>` : P.empty('block', t('contacts.no_blocked'), t('contacts.no_blocked_hint'));
    }
  }
  async function contactAction(action, userId, extra = {}) {
    try {
      const result = await P.post(action, { user_id: Number(userId), ...extra });
      P.toast(t(`contacts.done_${action.split('.')[1]}`), 'success');
      if (state.page === 'contacts') loadContacts();
      P.emit('contact-state', result);
      return result;
    } catch (error) { P.failed(error); return null; }
  }
  P.on('contacts-changed', () => { if (state.page === 'contacts') loadContacts(); });

  /* ---------- Calls tab ---------- */
  P.registerPage('calls', {
    render(el) {
      el.innerHTML = `<header class="app-bar"><h1>${esc(t('calls.title'))}</h1><button class="icon-btn" data-new-call aria-label="${esc(t('calls.new'))}">${icon('plus')}</button></header><div class="scroller"><div class="page-inner pad" id="calls-history"></div></div>`;
      window.PingUpCalls?.renderHistory($('#calls-history', el));
    },
  });

  /* ---------- New message / group / channel ---------- */
  Pages.newMessage = () => {
    const s = PU.sheet({ title: t('create.message'), full: PU.isMobile(), body: `<label class="searchbar" style="margin:0 0 10px">${icon('search')}<input data-people-search type="search" autocomplete="off" placeholder="${esc(t('contacts.search_people'))}"></label><div class="list" style="margin-bottom:8px"><button class="list-item" data-new-community="group"><span class="li-icon ic-violet">${icon('users')}</span><span class="li-body"><strong>${esc(t('create.group'))}</strong></span></button><button class="list-item" data-new-community="channel"><span class="li-icon ic-blue">${icon('channels')}</span><span class="li-body"><strong>${esc(t('create.channel'))}</strong></span></button></div><div class="group-title" style="padding-left:8px">${esc(t('contacts.title'))}</div><div class="list" data-people-results>${state.contacts.map(u => userRow(u, '', `data-direct-user="${u.id}"`)).join('') || `<p class="hint">${esc(t('contacts.search_hint'))}</p>`}</div>` });
    let timer = null, controller = null;
    s.el.addEventListener('input', event => {
      if (!event.target.matches('[data-people-search]')) return;
      const q = event.target.value.trim(), target = $('[data-people-results]', s.el);
      clearTimeout(timer); controller?.abort();
      const local = state.contacts.filter(u => `${u.name} ${u.username}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
      if (q.replace(/^@/, '').length < 3) { target.innerHTML = local.map(u => userRow(u, '', `data-direct-user="${u.id}"`)).join('') || `<p class="hint">${esc(t('search.min_chars'))}</p>`; return; }
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          const data = await P.api('search.global', { q, type: 'people' }, { signal: controller.signal });
          const ids = new Set(local.map(u => u.id));
          target.innerHTML = [...local, ...data.people.filter(u => !ids.has(u.id))].map(u => userRow(u, '', `data-direct-user="${u.id}"`)).join('') || `<p class="hint">${esc(t('contacts.no_results'))}</p>`;
        } catch (error) { if (error.name !== 'AbortError') target.innerHTML = errorBlock(error); }
      }, 300);
    });
    s.el.addEventListener('click', event => { if (event.target.closest('[data-direct-user],[data-new-community]')) s.close(); });
  };
  Pages.newCall = () => {
    const s = PU.sheet({ title: t('calls.new'), body: state.contacts.length ? `<div class="list">${state.contacts.map(u => `<div class="list-item">${P.avatar(u, '', { online: true })}<span class="li-body"><strong>${esc(u.name)}${P.badges(u)}</strong><small>${esc(P.lastSeen(u))}</small></span><button class="icon-btn" data-call-user="${u.id}" aria-label="${esc(t('chat.call'))}">${icon('phone')}</button><button class="icon-btn" data-video-user="${u.id}" aria-label="${esc(t('calls.video'))}">${icon('video')}</button></div>`).join('')}</div>` : P.empty('contacts', t('contacts.empty_title'), t('calls.need_contacts'), `<button class="btn primary" data-add-contact>${icon('userPlus')}${esc(t('contacts.add'))}</button>`) });
    s.el.addEventListener('click', event => { if (event.target.closest('[data-call-user],[data-video-user],[data-add-contact]')) s.close(); });
  };
  Pages.newCommunity = type => {
    const channel = type === 'channel';
    const members = channel ? '' : `<div class="field"><span>${esc(t('group.members'))}</span><div class="list" style="max-height:240px;overflow:auto">${state.contacts.map(u => `<label class="list-item">${P.avatar(u, 'sm')}<span class="li-body"><strong>${esc(u.name)}</strong><small>@${esc(u.username)}</small></span><input type="checkbox" name="user_ids" value="${u.id}"></label>`).join('') || `<p class="hint">${esc(t('group.no_contacts'))}</p>`}</div></div>`;
    const s = PU.sheet({ title: t(channel ? 'create.channel' : 'create.group'), full: PU.isMobile(), body: `<form class="form" id="community-form"><label class="field"><span>${esc(t(channel ? 'channel.name' : 'group.name'))}</span><input name="name" required maxlength="80" autofocus></label><label class="field"><span>${esc(t('channel.description'))}</span><textarea name="description" rows="3" maxlength="500" placeholder="${esc(t('channel.description_hint'))}"></textarea></label><div class="field"><span>${esc(t('channel.visibility'))}</span><div class="segmented"><button type="button" class="active" data-visibility="private">${icon('lock')} ${esc(t('channel.private'))}</button><button type="button" data-visibility="public">${icon('globe')} ${esc(t('channel.public'))}</button></div></div><label class="field" data-slug-field hidden><span>${esc(t('channel.slug'))}</span><div class="input-prefix"><i>@</i><input name="slug" maxlength="32" pattern="[a-z][a-z0-9_]{4,31}" placeholder="my_${channel ? 'channel' : 'group'}"></div><small>${esc(t('channel.slug_hint'))}</small></label>${channel ? `<div class="field"><span>${esc(t('channel.preset'))}</span><div class="preset-grid">${PRESETS.map(p => `<button type="button" class="preset-card ${p === 'classic' ? 'active' : ''}" data-preset-pick="${p}" data-preset="${p}"><span class="sample"><i></i></span><span>${esc(t(`preset.${p}`))}</span></button>`).join('')}</div></div>` : members}<div class="form-error" hidden></div><button class="btn primary block" type="submit">${icon('plus')}${esc(t('common.create'))}</button></form>` });
    let visibility = 'private', preset = 'classic';
    s.el.addEventListener('click', event => {
      const v = event.target.closest('[data-visibility]');
      if (v) { visibility = v.dataset.visibility; $$('[data-visibility]', s.el).forEach(b => b.classList.toggle('active', b === v)); $('[data-slug-field]', s.el).hidden = visibility !== 'public'; $('[name="slug"]', s.el).required = visibility === 'public'; }
      const p = event.target.closest('[data-preset-pick]');
      if (p) { preset = p.dataset.presetPick; $$('[data-preset-pick]', s.el).forEach(b => b.classList.toggle('active', b === p)); }
    });
    s.el.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, data = new FormData(form), button = $('[type=submit]', form);
      if (!form.reportValidity()) return;
      button.classList.add('loading');
      try {
        const conv = await P.post('conversations.create', { type, name: data.get('name'), description: data.get('description'), visibility, slug: visibility === 'public' ? data.get('slug') : null, user_ids: data.getAll('user_ids').map(Number), settings: channel ? { preset } : {} });
        s.close();
        P.retainConversation(conv);
        window.PingUpChat?.open(conv.id);
        P.toast(t(channel ? 'channel.created' : 'group.created'), 'success');
      } catch (error) { const e = $('.form-error', form); e.hidden = false; e.textContent = P.errText(error); }
      finally { button.classList.remove('loading'); }
    });
  };
  async function startDirect(userId) {
    try {
      const conv = await P.post('conversations.create', { type: 'direct', user_id: Number(userId) });
      P.retainConversation(conv);
      window.PingUpChat?.open(conv.id);
    } catch (error) { P.failed(error); }
  }
  Pages.startDirect = startDirect;

  /* ---------- Global search ---------- */
  Pages.search = (initial = '', { conversationId = null, type = null } = {}) => {
    const conv = conversationId ? P.findConversation(conversationId) : null;
    const types = conv ? ['messages', 'media', 'files'] : ['all', 'people', 'channels', 'groups', 'messages', 'media', 'files'];
    let current = type && types.includes(type) ? type : types[0];
    const s = PU.sheet({ title: conv ? t('search.in_chat', { name: P.convName(conv) }) : t('search.title'), full: true, wide: true, className: 'search-sheet', body: `<label class="searchbar" style="margin:0 0 6px">${icon('search')}<input data-global-search type="search" autocomplete="off" enterkeyhint="search" placeholder="${esc(t('search.hint'))}" value="${esc(initial)}"></label><div class="chips" style="padding:4px 0 10px">${types.map(x => `<button class="chip ${x === current ? 'active' : ''}" data-search-type="${x}">${esc(t(`search.type_${x}`))}</button>`).join('')}</div><div data-search-results><p class="hint">${esc(t('search.privacy_hint'))}</p></div>` });
    const input = $('[data-global-search]', s.el), target = $('[data-search-results]', s.el);
    let timer = null, controller = null;
    const run = () => {
      clearTimeout(timer); controller?.abort();
      const q = input.value.trim();
      if (q.length < 2 && !(conv && ['media', 'files'].includes(current))) { target.innerHTML = `<p class="hint">${esc(t(q ? 'search.min_chars' : 'search.privacy_hint'))}</p>`; return; }
      target.innerHTML = loading;
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          const data = await P.api('search.global', { q, type: current, conversation_id: conversationId || undefined }, { signal: controller.signal });
          target.innerHTML = renderResults(data, current, conv) || P.empty('search', t('search.no_results'), t('search.no_results_hint'));
        } catch (error) { if (error.name !== 'AbortError') target.innerHTML = errorBlock(error); }
      }, 300);
    };
    input.addEventListener('input', run);
    s.el.addEventListener('click', event => {
      const typeButton = event.target.closest('[data-search-type]');
      if (typeButton) { current = typeButton.dataset.searchType; $$('[data-search-type]', s.el).forEach(b => b.classList.toggle('active', b === typeButton)); run(); }
      const result = event.target.closest('[data-search-message]');
      if (result) { s.close(); const id = Number(result.dataset.searchMessage), c = Number(result.dataset.conversation); setTimeout(() => window.PingUpChat?.open(c, { messageId: id }), 50); }
      if (event.target.closest('[data-profile],[data-community-info],[data-join-public]')) setTimeout(() => s.close(), 0);
    });
    setTimeout(() => input.focus(), 50);
    if (initial || (conv && ['media', 'files'].includes(current))) run();
  };
  function renderResults(data, type, conv) {
    const parts = [];
    if (data.people?.length) parts.push(`<div class="group-title">${esc(t('search.type_people'))}</div><div class="list">${data.people.map(u => userRow(u)).join('')}</div>`);
    if (data.channels?.length) parts.push(`<div class="group-title">${esc(t('search.type_channels'))}</div><div class="list">${data.channels.map(c => communityRow({ ...c, type: 'channel' })).join('')}</div>`);
    if (data.groups?.length) parts.push(`<div class="group-title">${esc(t('search.type_groups'))}</div><div class="list">${data.groups.map(c => communityRow({ ...c, type: 'group' })).join('')}</div>`);
    const messageRow = m => { const c = P.findConversation(m.conversation_id); return `<button class="list-item" data-search-message="${m.id}" data-conversation="${m.conversation_id}">${c ? P.convAvatar(c, 'sm') : `<span class="li-icon ic-gray">${icon('chats')}</span>`}<span class="li-body"><strong>${esc(c ? P.convName(c) : t('nav.chats'))}</strong><small>${esc(P.messagePreview(m))}</small></span><span class="li-value">${esc(P.listTime(m.created_at))}</span></button>`; };
    if (data.messages?.length) parts.push(`<div class="group-title">${esc(t('search.type_messages'))}</div><div class="list">${data.messages.map(messageRow).join('')}</div>`);
    if (data.media?.length) {
      const files = data.media.flatMap(m => (m.kind === 'album' ? m.files : [m.file]).filter(f => f && ['image', 'video'].includes(f.kind)).map(f => ({ f, m })));
      parts.push(`<div class="shot-grid" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr))">${files.map(({ f, m }) => `<button class="shot" data-search-message="${m.id}" data-conversation="${m.conversation_id}">${f.kind === 'video' ? `<video src="${esc(f.url)}#t=0.1" muted preload="metadata"></video>` : `<img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy">`}</button>`).join('')}</div>`);
    }
    if (data.files?.length) parts.push(`<div class="list">${data.files.map(m => `<button class="list-item" data-search-message="${m.id}" data-conversation="${m.conversation_id}"><span class="li-icon ic-blue">${icon(m.file?.kind === 'audio' ? 'music' : 'file')}</span><span class="li-body"><strong>${esc(m.file?.name || m.text)}</strong><small>${esc(P.fileSize(m.file?.size))} · ${esc(P.listTime(m.created_at))}</small></span></button>`).join('')}</div>`);
    return parts.join('');
  }

  /* ---------- User profile ---------- */
  Pages.profile = async id => {
    if (Number(id) === Number(state.user.id)) { Pages.openSection?.('profile'); return; }
    const s = PU.sheet({ title: '', label: t('profile.view'), className: 'profile-sheet', body: loading });
    try {
      const u = await P.api('users.profile', { user_id: id });
      renderProfile(s, u);
    } catch (error) { s.body.innerHTML = errorBlock(error); }
  };
  function renderProfile(s, u) {
    const state_ = u.contact_state;
    const contactButton = { none: ['userPlus', 'contacts.add', 'add'], declined: ['userPlus', 'contacts.add', 'add'], outgoing: ['clock', 'contacts.requested', 'cancel'], incoming: ['check', 'contacts.accept', 'accept'], accepted: ['users', 'contacts.in_contacts', 'remove'], blocked: ['block', 'contacts.unblock', 'unblock'] }[state_] || null;
    s.body.innerHTML = `<div class="cover" style="background:${u.accent ? `linear-gradient(135deg, ${esc(u.accent)}, var(--accent-2))` : 'var(--gradient)'}"></div><div class="profile-hero">${P.avatar(u, 'xl', { online: true })}<h2>${esc(u.name)}${P.badges(u)}</h2><p>${esc(P.lastSeen(u))}</p></div><div class="profile-actions">${u.can_message ? `<button class="action" data-direct-user="${u.id}">${icon('chats')}${esc(t('profile.message'))}</button>` : ''}${u.can_call ? `<button class="action" data-call-user="${u.id}">${icon('phone')}${esc(t('chat.call'))}</button><button class="action" data-video-user="${u.id}">${icon('video')}${esc(t('calls.video'))}</button>` : ''}${contactButton ? `<button class="action" data-contact-op="${contactButton[2]}" data-user="${u.id}">${icon(contactButton[0])}${esc(t(contactButton[1]))}</button>` : ''}<button class="action" data-share-user="${esc(u.username)}">${icon('link')}${esc(t('common.share'))}</button></div><div class="group-card info-rows">${u.bio ? `<div class="list-item"><span class="li-icon ic-violet">${icon('info')}</span><span class="li-body"><strong>${esc(u.bio)}</strong><small>${esc(t('profile.bio'))}</small></span></div>` : ''}<div class="list-item"><span class="li-icon ic-blue">${icon('at')}</span><span class="li-body"><strong>@${esc(u.username)}</strong><small>${esc(t('profile.username'))}</small></span></div>${u.location ? `<div class="list-item"><span class="li-icon ic-green">${icon('location')}</span><span class="li-body"><strong>${esc(u.location)}</strong></span></div>` : ''}${u.website && /^https?:\/\//i.test(u.website) ? `<a class="list-item" href="${esc(u.website)}" target="_blank" rel="noopener noreferrer nofollow"><span class="li-icon ic-teal">${icon('globe')}</span><span class="li-body"><strong>${esc(u.website)}</strong></span></a>` : ''}${u.created_at ? `<div class="list-item"><span class="li-icon ic-orange">${icon('sparkles')}</span><span class="li-body"><strong>${esc(t('profile.joined', { date: P.longDate(u.created_at) }))}</strong></span></div>` : ''}${u.premium ? `<button class="list-item" data-open-section="premium"><span class="li-icon ic-premium">${icon('crown')}</span><span class="li-body"><strong>${esc(t('premium.member'))}</strong><small>${esc(t('premium.member_hint'))}</small></span></button>` : ''}</div><div class="group-card list">${state_ !== 'blocked' ? `<button class="list-item" data-block-user="${u.id}" style="color:var(--danger)"><span class="li-icon ic-red">${icon('block')}</span><span class="li-body"><strong>${esc(t('contacts.block'))}</strong></span></button>` : ''}<button class="list-item" data-report-user="${u.id}"><span class="li-icon ic-gray">${icon('alert')}</span><span class="li-body"><strong>${esc(t('feedback.report_user'))}</strong></span></button></div>`;
    s.el.addEventListener('click', async event => {
      const op = event.target.closest('[data-contact-op]');
      if (op) {
        const action = { add: 'contacts.request', cancel: 'contacts.cancel', accept: 'contacts.respond', remove: 'contacts.remove', unblock: 'users.unblock' }[op.dataset.contactOp];
        if (op.dataset.contactOp === 'remove' && !await PU.confirm({ title: t('contacts.remove'), text: t('contacts.remove_confirm', { name: u.name }), confirm: t('contacts.remove'), danger: true })) return;
        const result = await contactAction(action, u.id, action === 'contacts.respond' ? { accept: true } : {});
        if (result) renderProfile(s, { ...result.user, contact_state: result.state });
      }
      const share = event.target.closest('[data-share-user]');
      if (share) { const text = `@${share.dataset.shareUser}`; try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); P.toast(t('common.copied'), 'success'); } } catch { /* cancelled */ } }
      const block = event.target.closest('[data-block-user]');
      if (block) { s.close(); Pages.block(u); }
      if (event.target.closest('[data-report-user]')) { s.close(); Pages.feedbackForm?.('bug', 'other', t('feedback.report_user_title', { username: u.username })); }
      if (event.target.closest('[data-direct-user],[data-call-user],[data-video-user]')) s.close();
    });
  }
  Pages.block = async user => {
    if (!await PU.confirm({ title: t('contacts.block_title', { name: user.name }), text: t('contacts.block_text'), confirm: t('contacts.block'), danger: true })) return;
    await contactAction('users.block', user.id);
    P.poll();
  };
  P.on('contact-state', () => { if (state.page === 'contacts') loadContacts(); });

  /* ---------- Communities ---------- */
  Pages.joinSlug = async slug => {
    try {
      const conv = await P.post('channels.join', { slug });
      P.retainConversation(conv);
      window.PingUpChat?.open(conv.id);
    } catch (error) { P.failed(error); }
  };
  Pages.joinInvite = async token => {
    try {
      const conv = await P.post('channels.join', { invite_token: token });
      P.retainConversation(conv);
      window.PingUpChat?.open(conv.id);
      P.toast(t('channel.joined'), 'success');
    } catch (error) { P.failed(error); }
  };
  async function joinPublic(id) {
    const existing = P.findConversation(id);
    if (existing) { window.PingUpChat?.open(id); return; }
    try {
      const conv = await P.post('channels.join', { conversation_id: Number(id) });
      P.retainConversation(conv);
      window.PingUpChat?.open(conv.id);
      P.toast(t('channel.joined'), 'success');
    } catch (error) { P.failed(error); }
  }
  Pages.leaveCommunity = async conv => {
    if (!await PU.confirm({ title: t(conv.type === 'channel' ? 'channel.leave' : 'group.leave'), text: t('channel.leave_confirm', { name: conv.name }), confirm: t('channel.leave'), danger: true })) return;
    try { await P.post('channels.leave', { conversation_id: conv.id }); P.removeConversation(conv.id); P.toast(t('channel.left'), 'success'); }
    catch (error) { P.failed(error); }
  };
  Pages.communityInfo = id => {
    const conv = P.findConversation(id);
    if (!conv) return;
    const s = PU.sheet({ title: '', label: conv.name, className: 'profile-sheet', body: communityInfoHTML(conv) });
    s.el.addEventListener('click', async event => {
      if (event.target.closest('[data-manage-community]')) { s.close(); manageCommunity(conv.id); }
      if (event.target.closest('[data-leave-community]')) { s.close(); Pages.leaveCommunity(conv); }
      const copy = event.target.closest('[data-copy]');
      if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); P.toast(t('common.copied'), 'success'); } catch { P.toast(t('common.error'), 'error'); } }
      if (event.target.closest('[data-add-members]')) { s.close(); addMembers(conv); }
      if (event.target.closest('[data-profile],[data-open-conversation]')) s.close();
    });
  };
  function inviteUrl(token) { return `${location.origin}${location.pathname}?invite=${encodeURIComponent(token)}`; }
  function communityInfoHTML(conv) {
    const s = conv.settings || {}, channel = conv.type === 'channel';
    const link = conv.slug && conv.visibility === 'public' ? `@${conv.slug}` : '';
    const participants = (conv.participants || []).slice(0, 50);
    return `<div class="channel-cover" style="${conv.cover_url ? `background-image:url('${esc(conv.cover_url)}')` : s.accent ? `background:linear-gradient(135deg, ${esc(s.accent)}, var(--accent-2))` : ''}"></div><div class="profile-hero">${P.convAvatar(conv, 'xl')}<h2>${esc(conv.name)}</h2><p>${conv.member_count !== null ? esc(t(channel ? 'channel.subscribers' : 'chat.participants', { count: conv.member_count })) : ''}${link ? ' · ' + esc(link) : ''}</p>${s.tagline ? `<p>${esc(s.tagline)}</p>` : ''}${s.links?.length ? `<div class="channel-links">${s.links.map(l => `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${icon('link')}${esc(l.title)}</a>`).join('')}</div>` : ''}</div><div class="profile-actions"><button class="action" data-open-conversation="${conv.id}">${icon('chats')}${esc(t('channel.open'))}</button>${conv.permissions?.change_info || conv.permissions?.manage_members || conv.permissions?.view_stats || conv.permissions?.invite ? `<button class="action" data-manage-community>${icon('settings')}${esc(t(channel ? 'channel.manage' : 'group.manage'))}</button>` : ''}${conv.type === 'group' && conv.permissions?.invite ? `<button class="action" data-add-members>${icon('userPlus')}${esc(t('group.add_members'))}</button>` : ''}${conv.role !== 'owner' ? `<button class="action danger" data-leave-community>${icon('logout')}${esc(t(channel ? 'channel.leave' : 'group.leave'))}</button>` : ''}</div>${s.welcome ? `<div class="group-card pad" style="padding:14px">${PU.format(s.welcome)}</div>` : ''}<div class="group-card info-rows">${conv.description ? `<div class="list-item"><span class="li-icon ic-violet">${icon('info')}</span><span class="li-body"><strong style="white-space:normal">${esc(conv.description)}</strong><small>${esc(t('channel.description'))}</small></span></div>` : ''}${link ? `<button class="list-item" data-copy="${esc(`${location.origin}${location.pathname}?join=${encodeURIComponent(conv.slug)}`)}"><span class="li-icon ic-blue">${icon('at')}</span><span class="li-body"><strong>${esc(link)}</strong><small>${esc(t('channel.public_link'))}</small></span></button>` : ''}${conv.invite_token ? `<button class="list-item" data-copy="${esc(inviteUrl(conv.invite_token))}"><span class="li-icon ic-teal">${icon('link')}</span><span class="li-body"><strong>${esc(t('channel.copy_invite'))}</strong><small>${esc(t('channel.invite_hint'))}</small></span></button>` : ''}${s.category && s.category !== 'other' ? `<div class="list-item"><span class="li-icon ic-orange">${icon('hash')}</span><span class="li-body"><strong>${esc(t(`category.${s.category}`))}</strong><small>${esc(t('channel.category'))}</small></span></div>` : ''}${conv.discussion_id ? `<button class="list-item" data-open-conversation="${conv.discussion_id}"><span class="li-icon ic-green">${icon('comment')}</span><span class="li-body"><strong>${esc(t('channel.discussion'))}</strong></span></button>` : ''}</div>${participants.length && (conv.type === 'group' || conv.permissions?.manage_members) ? `<div class="group-title">${esc(t(channel ? 'channel.admins' : 'group.members'))}</div><div class="group-card list">${participants.map(u => userRow(u, u.member_role && u.member_role !== 'member' ? `<span class="status-pill">${esc(t(`role.${u.member_role}`))}</span>` : '')).join('')}</div>` : ''}`;
  }
  function addMembers(conv) {
    const present = new Set((conv.participants || []).map(u => u.id));
    const candidates = state.contacts.filter(u => !present.has(u.id));
    const s = PU.sheet({ title: t('group.add_members'), body: candidates.length ? `<form class="form" data-add-form><div class="list">${candidates.map(u => `<label class="list-item">${P.avatar(u, 'sm')}<span class="li-body"><strong>${esc(u.name)}</strong></span><input type="checkbox" name="ids" value="${u.id}"></label>`).join('')}</div><button class="btn primary block" type="submit">${esc(t('common.add'))}</button></form>` : `<p class="hint">${esc(t('group.no_contacts'))}</p>` });
    s.el.addEventListener('submit', async event => {
      event.preventDefault();
      const ids = new FormData(event.target).getAll('ids').map(Number);
      if (!ids.length) return;
      try { P.retainConversation(await P.post('channels.update', { conversation_id: conv.id, add_user_ids: ids })); s.close(); P.toast(t('group.members_added'), 'success'); }
      catch (error) { P.failed(error); }
    });
  }

  /* Community management: info, appearance, members, bans, invites, audit, stats, danger zone. */
  function manageCommunity(id) {
    let conv = P.findConversation(id);
    if (!conv) return;
    const perms = conv.permissions || {};
    const sections = [
      perms.change_info && ['info', 'info', 'channel.section_info'],
      perms.change_info && conv.type === 'channel' && ['palette', 'appearance', 'channel.section_appearance'],
      perms.manage_members && ['users', 'members', 'channel.section_members'],
      perms.ban && ['block', 'bans', 'channel.section_bans'],
      perms.invite && ['link', 'invites', 'channel.section_invites'],
      perms.view_stats && ['chart', 'stats', 'channel.section_stats'],
      (conv.role === 'owner' || conv.role === 'admin') && ['shield', 'audit', 'channel.section_audit'],
      conv.role === 'owner' && ['alert', 'danger', 'channel.section_danger'],
    ].filter(Boolean);
    const page = subpage(t(conv.type === 'channel' ? 'channel.manage' : 'group.manage'));
    page.body.innerHTML = `<div class="profile-hero">${P.convAvatar(conv, 'lg')}<h2>${esc(conv.name)}</h2></div><div class="group-card list">${sections.map(([ic, key, label]) => `<button class="list-item" data-manage-section="${key}"><span class="li-icon ic-${{ info: 'violet', appearance: 'pink', members: 'blue', bans: 'red', invites: 'teal', stats: 'green', audit: 'gray', danger: 'red' }[key]}">${icon(ic)}</span><span class="li-body"><strong>${esc(t(label))}</strong></span>${icon('chevron')}</button>`).join('')}</div>`;
    page.el.addEventListener('click', event => {
      const b = event.target.closest('[data-manage-section]');
      if (!b) return;
      conv = P.findConversation(id) || conv;
      ({ info: manageInfo, appearance: manageAppearance, members: manageMembers, bans: manageBans, invites: manageInvites, stats: manageStats, audit: manageAudit, danger: manageDanger })[b.dataset.manageSection](conv);
    });
  }
  async function updateCommunity(conv, payload, okKey = 'channel.updated') {
    const fresh = await P.post('channels.update', { conversation_id: conv.id, ...payload });
    P.retainConversation(fresh);
    P.toast(t(okKey), 'success');
    return fresh;
  }
  function manageInfo(conv) {
    const page = subpage(t('channel.section_info'));
    page.body.innerHTML = `<form class="form pad" id="community-info-form"><div class="profile-hero"><button type="button" data-pick-image="avatar_file_id">${P.convAvatar(conv, 'xl')}</button><button type="button" class="text-btn" data-pick-image="avatar_file_id">${esc(t('channel.change_avatar'))}</button></div><label class="field"><span>${esc(t('channel.name'))}</span><input name="name" required maxlength="80" value="${esc(conv.name)}"></label><label class="field"><span>${esc(t('channel.description'))}</span><textarea name="description" rows="4" maxlength="500">${esc(conv.description || '')}</textarea></label><label class="field"><span>${esc(t('channel.visibility'))}</span><select name="visibility"><option value="private" ${conv.visibility !== 'public' ? 'selected' : ''}>${esc(t('channel.private'))}</option><option value="public" ${conv.visibility === 'public' ? 'selected' : ''}>${esc(t('channel.public'))}</option></select></label><label class="field"><span>${esc(t('channel.slug'))}</span><div class="input-prefix"><i>@</i><input name="slug" maxlength="32" pattern="[a-z][a-z0-9_]{4,31}" value="${esc(conv.slug || '')}"></div><small>${esc(t('channel.slug_hint'))}</small></label>${conv.type === 'channel' ? `<button type="button" class="btn" data-pick-image="cover_file_id">${icon('image')}${esc(t('channel.change_cover'))}</button>` : ''}<div class="form-error" hidden></div><button class="btn primary block" type="submit">${esc(t('common.save'))}</button></form>`;
    page.el.addEventListener('click', event => {
      const pick = event.target.closest('[data-pick-image]');
      if (!pick) return;
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
      input.onchange = async () => {
        if (!input.files[0]) return;
        try { const file = await P.uploadFile(input.files[0], 'avatar'); await updateCommunity(conv, { [pick.dataset.pickImage]: file.id }); page.close(); }
        catch (error) { P.failed(error); }
      };
      input.click();
    });
    page.el.addEventListener('submit', async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      if (!data.slug) data.slug = null;
      try { await updateCommunity(conv, data); page.close(); }
      catch (error) { const e = $('.form-error', page.el); e.hidden = false; e.textContent = P.errText(error); }
    });
  }
  function manageAppearance(conv) {
    const s = { ...(conv.settings || {}) };
    const page = subpage(t('channel.section_appearance'));
    const render = () => {
      page.body.innerHTML = `<div class="preview-chat channel-skin" data-preset="${esc(s.preset || 'classic')}" data-card="${esc(s.card_style || 'elevated')}" style="${previewVars(s)}" data-preview><div style="position:relative;display:flex;align-items:center;gap:10px;padding:8px;border-radius:14px;background:color-mix(in srgb,var(--ch-header) 92%,transparent)">${P.convAvatar(conv, 'sm')}<strong>${esc(conv.name)}</strong></div><div class="msg"><div class="msg-col"><div class="bubble"><div class="msg-text">${esc(s.welcome || t('channel.preview_post'))}<span class="msg-meta"><span class="views">${icon('eye')}128</span><time>12:00</time></span></div>${s.comments_enabled ? `<button class="post-comments">${icon('comment')}<span>${esc(t('channel.comments_count', { count: 4 }))}</span></button>` : ''}</div>${s.reactions_enabled !== false ? `<div class="msg-reactions"><span class="reaction mine">🔥<span>12</span></span><span class="reaction">❤️<span>7</span></span></div>` : ''}</div></div><button class="btn primary small" style="justify-self:start;position:relative">${esc(t('channel.join'))}</button></div><div class="group-title">${esc(t('channel.preset'))}</div><div class="pad"><div class="preset-grid">${PRESETS.map(p => `<button type="button" class="preset-card ${p === (s.preset || 'classic') ? 'active' : ''}" data-preset="${p}" data-set-preset="${p}"><span class="sample"><i></i></span><span>${esc(t(`preset.${p}`))}</span></button>`).join('')}</div></div><div class="group-title">${esc(t('channel.colors'))}</div><div class="group-card pad">${[['accent', 'channel.color_accent'], ['header_color', 'channel.color_header'], ['background', 'channel.color_background'], ['button_color', 'channel.color_button']].map(([k, l]) => `<label class="color-row"><span>${esc(t(l))}</span><input type="color" data-color="${k}" value="${esc(s[k] || '#a78bfa')}"><button type="button" class="text-btn" data-clear-color="${k}">${esc(t('common.reset'))}</button></label>`).join('')}<label class="color-row"><span>${esc(t('channel.gradient'))}</span><input type="color" data-gradient="from" value="${esc(s.gradient?.from || '#8a79ff')}"><input type="color" data-gradient="to" value="${esc(s.gradient?.to || '#59c9ee')}"><button type="button" class="text-btn" data-clear-gradient>${esc(t('common.reset'))}</button></label></div><div class="group-title">${esc(t('channel.card_style'))}</div><div class="chips">${['elevated', 'flat', 'outlined', 'glass'].map(c => `<button class="chip ${(s.card_style || 'elevated') === c ? 'active' : ''}" data-card-style="${c}">${esc(t(`card.${c}`))}</button>`).join('')}</div><form class="form pad" data-appearance-form><label class="field"><span>${esc(t('channel.tagline'))}</span><input name="tagline" maxlength="120" value="${esc(s.tagline || '')}"></label><label class="field"><span>${esc(t('channel.welcome'))}</span><textarea name="welcome" rows="3" maxlength="500">${esc(s.welcome || '')}</textarea></label><label class="field"><span>${esc(t('channel.category'))}</span><select name="category">${CATEGORIES.map(c => `<option value="${c}" ${s.category === c ? 'selected' : ''}>${esc(t(`category.${c}`))}</option>`).join('')}</select></label><label class="field"><span>${esc(t('channel.language'))}</span><select name="language">${['uk', 'ru', 'en', 'other'].map(l => `<option value="${l}" ${s.language === l ? 'selected' : ''}>${esc(t(`language.${l}`))}</option>`).join('')}</select></label><label class="field"><span>${esc(t('channel.links'))}</span><textarea name="links" rows="3" placeholder="${esc(t('channel.links_hint'))}">${esc((s.links || []).map(l => `${l.title} | ${l.url}`).join('\n'))}</textarea></label>${[['show_subscriber_count', 'channel.show_subscribers'], ['show_author', 'channel.show_author'], ['reactions_enabled', 'channel.reactions_enabled'], ['comments_enabled', 'channel.comments_enabled']].map(([k, l]) => `<label class="option-row"><span class="li-body">${esc(t(l))}</span><span class="switch"><input type="checkbox" name="${k}" ${s[k] !== false ? 'checked' : ''}><i></i></span></label>`).join('')}<label class="field"><span>${esc(t('channel.allowed_reactions'))}</span><input name="allowed_reactions" value="${esc((s.allowed_reactions || []).join(' '))}" placeholder="❤️ 👍 🔥"><small>${esc(t('channel.allowed_reactions_hint'))}</small></label><label class="field"><span>${esc(t('channel.discussion'))}</span><select name="discussion_id"><option value="">${esc(t('common.none'))}</option>${state.conversations.filter(c => c.type === 'group' && ['owner', 'admin'].includes(c.role)).map(c => `<option value="${c.id}" ${conv.discussion_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label><div class="form-error" hidden></div><button class="btn primary block" type="submit">${esc(t('channel.save_appearance'))}</button></form>`;
    };
    const refreshPreview = () => { const el = $('[data-preview]', page.el); if (el) { el.dataset.preset = s.preset || 'classic'; el.dataset.card = s.card_style || 'elevated'; el.style.cssText = previewVars(s); } };
    render();
    page.el.addEventListener('click', event => {
      const preset = event.target.closest('[data-set-preset]');
      if (preset) { s.preset = preset.dataset.setPreset; $$('[data-set-preset]', page.el).forEach(b => b.classList.toggle('active', b === preset)); refreshPreview(); }
      const card = event.target.closest('[data-card-style]');
      if (card) { s.card_style = card.dataset.cardStyle; $$('[data-card-style]', page.el).forEach(b => b.classList.toggle('active', b === card)); refreshPreview(); }
      const clear = event.target.closest('[data-clear-color]');
      if (clear) { s[clear.dataset.clearColor] = null; refreshPreview(); }
      if (event.target.closest('[data-clear-gradient]')) { s.gradient = null; refreshPreview(); }
    });
    page.el.addEventListener('input', event => {
      if (event.target.dataset.color) { s[event.target.dataset.color] = event.target.value; refreshPreview(); }
      if (event.target.dataset.gradient) { s.gradient = { from: $('[data-gradient="from"]', page.el).value, to: $('[data-gradient="to"]', page.el).value, angle: 135 }; refreshPreview(); }
    });
    page.el.addEventListener('submit', async event => {
      event.preventDefault();
      const f = new FormData(event.target);
      const links = String(f.get('links') || '').split('\n').map(line => line.split('|').map(x => x.trim())).filter(([title, url]) => title && url).map(([title, url]) => ({ title, url }));
      const settings = {
        preset: s.preset || 'classic', card_style: s.card_style || 'elevated', accent: s.accent || null, header_color: s.header_color || null, background: s.background || null, button_color: s.button_color || null, gradient: s.gradient || null,
        tagline: f.get('tagline'), welcome: f.get('welcome'), category: f.get('category'), language: f.get('language'), links,
        show_subscriber_count: f.get('show_subscriber_count') === 'on', show_author: f.get('show_author') === 'on', reactions_enabled: f.get('reactions_enabled') === 'on', comments_enabled: f.get('comments_enabled') === 'on',
        allowed_reactions: String(f.get('allowed_reactions') || '').split(/\s+/).filter(Boolean),
      };
      try { await updateCommunity(conv, { settings, discussion_id: f.get('discussion_id') ? Number(f.get('discussion_id')) : null }); page.close(); }
      catch (error) { const e = $('.form-error', page.el); e.hidden = false; e.textContent = P.errText(error); }
    });
  }
  function previewVars(s) {
    const vars = [];
    if (s.accent) vars.push(`--ch-accent:${s.accent}`);
    if (s.header_color) vars.push(`--ch-header:${s.header_color}`);
    if (s.button_color) vars.push(`--ch-button:${s.button_color}`);
    if (s.gradient) vars.push(`--ch-bg:linear-gradient(${s.gradient.angle || 135}deg,${s.gradient.from}33,${s.gradient.to}33)`);
    else if (s.background) vars.push(`--ch-bg:${s.background}`);
    vars.push('background:var(--ch-bg, var(--bg))');
    return vars.join(';');
  }
  async function manageMembers(conv) {
    const page = subpage(t('channel.section_members'));
    page.body.innerHTML = `<label class="searchbar">${icon('search')}<input data-member-search placeholder="${esc(t('channel.member_search'))}"></label><div data-members>${loading}</div>`;
    let offset = 0, q = '';
    const load = async (append = false) => {
      const target = $('[data-members]', page.el);
      try {
        const data = await P.api('channels.members', { conversation_id: conv.id, q, offset });
        const rows = data.members.map(m => `<div class="list-item">${userRow(m.user, m.role !== 'member' ? `<span class="status-pill">${esc(t(`role.${m.role}`))}</span>` : '').replace('class="list-item"', 'class="list-item" style="padding:0;flex:1"')}${m.role !== 'owner' && m.user.id !== state.user.id ? `<button class="icon-btn" data-member-menu="${m.user.id}" data-role="${m.role}" aria-label="${esc(t('chat.more'))}">${icon('vmore')}</button>` : ''}</div>`).join('');
        const html = `${append ? '' : `<p class="hint">${esc(t('channel.member_total', { count: data.total }))}</p>`}<div class="group-card list">${rows}</div>${data.has_more ? `<button class="btn block" data-more-members>${esc(t('common.more'))}</button>` : ''}`;
        if (append) { $('[data-more-members]', target)?.remove(); target.insertAdjacentHTML('beforeend', html); } else target.innerHTML = html;
      } catch (error) { target.innerHTML = errorBlock(error); }
    };
    page.el.addEventListener('input', PU.debounce(event => { if (event.target.matches('[data-member-search]')) { q = event.target.value.trim(); offset = 0; load(); } }, 300));
    page.el.addEventListener('click', event => {
      if (event.target.closest('[data-more-members]')) { offset += 50; load(true); }
      const menuButton = event.target.closest('[data-member-menu]');
      if (!menuButton) return;
      const userId = Number(menuButton.dataset.memberMenu), role = menuButton.dataset.role;
      PU.menu([
        conv.role === 'owner' && role === 'member' ? { icon: 'shield', label: t('channel.make_admin'), action: () => adminPermissions(conv, userId, load) } : null,
        conv.role === 'owner' && role === 'admin' ? { icon: 'edit', label: t('channel.edit_permissions'), action: () => adminPermissions(conv, userId, load) } : null,
        conv.role === 'owner' && role === 'admin' ? { icon: 'users', label: t('channel.remove_admin'), action: async () => { try { await P.post('channels.set_role', { conversation_id: conv.id, user_id: userId, role: 'member' }); load(); } catch (error) { P.failed(error); } } } : null,
        { icon: 'logout', label: t('channel.remove_member'), danger: true, action: async () => { try { await updateCommunity(conv, { remove_user_ids: [userId] }, 'channel.member_removed'); load(); } catch (error) { P.failed(error); } } },
        conv.permissions?.ban ? { icon: 'block', label: t('channel.ban'), danger: true, action: async () => { const reason = await PU.confirm({ title: t('channel.ban'), text: t('channel.ban_text'), confirm: t('channel.ban'), danger: true, input: { label: t('channel.ban_reason') } }); if (reason === null) return; try { await P.post('channels.ban', { conversation_id: conv.id, user_id: userId, reason }); P.toast(t('channel.banned'), 'success'); load(); } catch (error) { P.failed(error); } } } : null,
      ], PU.isMobile() ? {} : { anchor: menuButton });
    });
    load();
  }
  function adminPermissions(conv, userId, done) {
    const keys = ['post', 'edit_others', 'delete_others', 'pin', 'manage_members', 'ban', 'invite', 'change_info', 'view_stats', 'moderate_comments'];
    const s = PU.sheet({ title: t('channel.admin_rights'), body: `<form class="form">${keys.map(k => `<label class="option-row"><span class="li-body">${esc(t(`perm.${k}`))}</span><span class="switch"><input type="checkbox" name="${k}" ${k !== 'change_info' ? 'checked' : ''}><i></i></span></label>`).join('')}<button class="btn primary block" type="submit">${esc(t('common.save'))}</button></form>` });
    s.el.addEventListener('submit', async event => {
      event.preventDefault();
      const f = new FormData(event.target), permissions = Object.fromEntries(keys.map(k => [k, f.get(k) === 'on']));
      try { await P.post('channels.set_role', { conversation_id: conv.id, user_id: userId, role: 'admin', permissions }); s.close(); P.toast(t('channel.admin_saved'), 'success'); done(); }
      catch (error) { P.failed(error); }
    });
  }
  async function manageBans(conv) {
    const page = subpage(t('channel.section_bans'));
    const load = async () => {
      try {
        const data = await P.api('channels.bans', { conversation_id: conv.id });
        page.body.innerHTML = data.bans.length ? `<div class="group-card list">${data.bans.map(b => `<div class="list-item">${P.avatar(b.user, 'sm')}<span class="li-body"><strong>${esc(b.user.name)}</strong><small>${esc(b.reason || t('channel.no_reason'))} · ${esc(P.listTime(b.created_at))}</small></span><button class="btn small" data-unban="${b.user.id}">${esc(t('channel.unban'))}</button></div>`).join('')}</div>` : P.empty('block', t('channel.no_bans'));
      } catch (error) { page.body.innerHTML = errorBlock(error); }
    };
    page.el.addEventListener('click', async event => { const b = event.target.closest('[data-unban]'); if (b) { try { await P.post('channels.unban', { conversation_id: conv.id, user_id: Number(b.dataset.unban) }); load(); } catch (error) { P.failed(error); } } });
    page.body.innerHTML = loading;
    load();
  }
  async function manageInvites(conv) {
    const page = subpage(t('channel.section_invites'));
    const render = data => {
      page.body.innerHTML = `${data.primary ? `<div class="group-title">${esc(t('channel.primary_link'))}</div><div class="group-card list"><button class="list-item" data-copy-link="${esc(inviteUrl(data.primary))}"><span class="li-icon ic-teal">${icon('link')}</span><span class="li-body"><strong>${esc(inviteUrl(data.primary))}</strong><small>${esc(t('channel.copy_invite'))}</small></span></button><button class="list-item" data-rotate-primary><span class="li-icon ic-orange">${icon('refresh')}</span><span class="li-body"><strong>${esc(t('channel.rotate_invite'))}</strong><small>${esc(t('channel.rotate_hint'))}</small></span></button></div>` : ''}<div class="group-title">${esc(t('channel.extra_links'))}</div><form class="form pad" data-invite-form><label class="field"><span>${esc(t('channel.invite_name'))}</span><input name="name" maxlength="60"></label><label class="field"><span>${esc(t('channel.invite_limit'))}</span><select name="max_uses"><option value="">${esc(t('channel.unlimited'))}</option>${[1, 5, 10, 50, 100].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label><label class="field"><span>${esc(t('channel.invite_expiry'))}</span><select name="expires_in"><option value="">${esc(t('channel.never'))}</option><option value="3600">${esc(t('time.hour'))}</option><option value="86400">${esc(t('time.day'))}</option><option value="604800">${esc(t('time.week'))}</option><option value="2592000">${esc(t('time.month'))}</option></select></label><button class="btn primary" type="submit">${icon('plus')}${esc(t('channel.create_link'))}</button></form><div class="group-card list">${data.invites.map(i => `<div class="list-item"><span class="li-icon ${i.revoked || i.expired ? 'ic-gray' : 'ic-teal'}">${icon('link')}</span><span class="li-body"><strong>${esc(i.name || t('channel.invite_link'))}</strong><small>${esc(t('channel.invite_uses', { uses: i.uses, max: i.max_uses ?? '∞' }))}${i.expires_at ? ' · ' + esc(t('channel.expires', { date: P.listTime(i.expires_at) })) : ''}${i.revoked ? ' · ' + esc(t('channel.revoked')) : i.expired ? ' · ' + esc(t('channel.expired')) : ''}</small></span>${!i.revoked && !i.expired ? `<button class="icon-btn" data-copy-link="${esc(inviteUrl(i.token))}" aria-label="${esc(t('common.copy'))}">${icon('copy')}</button><button class="icon-btn" data-revoke-invite="${i.id}" aria-label="${esc(t('channel.revoke'))}">${icon('trash')}</button>` : ''}</div>`).join('') || `<p class="hint">${esc(t('channel.no_extra_links'))}</p>`}</div>`;
    };
    const load = async () => { try { render(await P.api('channels.invites', { conversation_id: conv.id })); } catch (error) { page.body.innerHTML = errorBlock(error); } };
    page.el.addEventListener('click', async event => {
      const copy = event.target.closest('[data-copy-link]');
      if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copyLink); P.toast(t('common.copied'), 'success'); } catch { P.toast(t('common.error'), 'error'); } }
      if (event.target.closest('[data-rotate-primary]')) { try { await updateCommunity(conv, { rotate_invite: true }, 'channel.invite_rotated'); load(); } catch (error) { P.failed(error); } }
      const revoke = event.target.closest('[data-revoke-invite]');
      if (revoke) { try { render(await P.post('channels.invite_revoke', { conversation_id: conv.id, invite_id: Number(revoke.dataset.revokeInvite) })); } catch (error) { P.failed(error); } }
    });
    page.el.addEventListener('submit', async event => {
      event.preventDefault();
      const f = new FormData(event.target);
      try { render(await P.post('channels.invite_create', { conversation_id: conv.id, name: f.get('name'), max_uses: f.get('max_uses') ? Number(f.get('max_uses')) : null, expires_in: f.get('expires_in') ? Number(f.get('expires_in')) : null })); P.toast(t('channel.link_created'), 'success'); }
      catch (error) { P.failed(error); }
    });
    page.body.innerHTML = loading;
    load();
  }
  async function manageAudit(conv) {
    const page = subpage(t('channel.section_audit'));
    page.body.innerHTML = loading;
    try {
      const data = await P.api('channels.audit', { conversation_id: conv.id });
      page.body.innerHTML = data.entries.length ? `<div class="group-card list">${data.entries.map(e => `<div class="list-item"><span class="li-icon ic-gray">${icon('shield')}</span><span class="li-body"><strong>${esc(t(`audit.${e.action}`, { actor: e.actor_name || '—', target: e.target_name || '' }))}</strong><small>${esc(e.actor_name || '—')}${e.target_name ? ' → ' + esc(e.target_name) : ''} · ${esc(new Date(e.created_at * 1000).toLocaleString(state.locale))}</small></span></div>`).join('')}</div>` : P.empty('shield', t('channel.audit_empty'));
    } catch (error) { page.body.innerHTML = errorBlock(error); }
  }
  function lineChart(series, key) {
    const w = 320, h = 140, pad = 22, max = Math.max(1, ...series.map(d => d[key]));
    const x = i => pad + i * (w - pad * 2) / Math.max(1, series.length - 1), y = v => h - pad - v / max * (h - pad * 2);
    const line = series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('');
    const labels = series.map((d, i) => i % Math.ceil(series.length / 7) === 0 ? `<text x="${x(i)}" y="${h - 4}" text-anchor="middle">${esc(d.day.slice(5))}</text>` : '').join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t(`stats.${key}`))}"><line class="grid" x1="${pad}" x2="${w - pad}" y1="${y(max)}" y2="${y(max)}"/><line class="grid" x1="${pad}" x2="${w - pad}" y1="${y(0)}" y2="${y(0)}"/><text x="2" y="${y(max) + 3}">${max}</text><path class="area" d="${line}L${x(series.length - 1)},${y(0)}L${x(0)},${y(0)}Z"/><path class="line" d="${line}"/>${labels}</svg>`;
  }
  function barChart(series, key) {
    const w = 320, h = 140, pad = 22, max = Math.max(1, ...series.map(d => d[key])), bw = (w - pad * 2) / series.length;
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t(`stats.${key}`))}">${series.map((d, i) => `<rect class="bar" x="${(pad + i * bw + 1).toFixed(1)}" y="${(h - pad - d[key] / max * (h - pad * 2)).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(d[key] / max * (h - pad * 2)).toFixed(1)}" rx="2"><title>${esc(d.day)}: ${d[key]}</title></rect>`).join('')}<text x="2" y="${pad + 3}">${max}</text></svg>`;
  }
  async function manageStats(conv) {
    const page = subpage(t('channel.section_stats'));
    let days = 7;
    const load = async () => {
      page.body.innerHTML = loading;
      try {
        const data = await P.api('channels.stats', { conversation_id: conv.id, days });
        const growth = data.growth;
        page.body.innerHTML = `<div class="chips">${[7, 30].map(d => `<button class="chip ${d === days ? 'active' : ''}" data-stat-days="${d}">${esc(t('stats.days', { count: d }))}</button>`).join('')}</div><div class="pad"><div class="stat-grid"><div class="stat"><small>${esc(t('stats.subscribers'))}</small><strong>${data.subscribers}</strong><small class="delta ${growth >= 0 ? 'up' : 'down'}">${growth >= 0 ? '+' : ''}${growth}</small></div><div class="stat"><small>${esc(t('stats.views'))}</small><strong>${data.totals.views}</strong></div><div class="stat"><small>${esc(t('stats.reactions'))}</small><strong>${data.totals.reactions}</strong></div><div class="stat"><small>${esc(t('stats.comments'))}</small><strong>${data.totals.comments}</strong></div></div><div class="group-title" style="padding-left:4px">${esc(t('stats.views'))}</div>${lineChart(data.series, 'views')}<div class="group-title" style="padding-left:4px">${esc(t('stats.growth'))}</div>${barChart(data.series.map(d => ({ ...d, net: Math.max(0, d.joins - d.leaves) })), 'net')}<div class="group-title" style="padding-left:4px">${esc(t('stats.reactions'))}</div>${barChart(data.series, 'reactions')}<div class="group-title" style="padding-left:4px">${esc(t('stats.top_posts'))}</div><div class="list">${data.top_posts.map(p => `<button class="list-item" data-jump-post="${p.id}"><span class="li-body"><strong>${esc(p.text || t(`chat.${p.kind === 'text' ? 'message' : 'file'}`))}</strong><small>👁 ${p.views} · ❤️ ${p.reactions} · 💬 ${p.comments}</small></span></button>`).join('') || `<p class="hint">${esc(t('stats.no_posts'))}</p>`}</div><p class="hint">${esc(t('stats.privacy_note'))}</p></div>`;
      } catch (error) { page.body.innerHTML = errorBlock(error); }
    };
    page.el.addEventListener('click', event => {
      const d = event.target.closest('[data-stat-days]');
      if (d) { days = Number(d.dataset.statDays); load(); }
      const post = event.target.closest('[data-jump-post]');
      if (post) { page.close(); window.PingUpChat?.open(conv.id, { messageId: Number(post.dataset.jumpPost) }); }
    });
    load();
  }
  function manageDanger(conv) {
    const page = subpage(t('channel.section_danger'));
    page.body.innerHTML = `<div class="group-card list"><button class="list-item" data-transfer><span class="li-icon ic-orange">${icon('key')}</span><span class="li-body"><strong>${esc(t('channel.transfer'))}</strong><small>${esc(t('channel.transfer_hint'))}</small></span></button><button class="list-item" data-archive-community><span class="li-icon ic-gray">${icon('archive')}</span><span class="li-body"><strong>${esc(t(conv.community_archived ? 'channel.unarchive' : 'channel.archive'))}</strong><small>${esc(t('channel.archive_hint'))}</small></span></button><button class="list-item" data-delete-community style="color:var(--danger)"><span class="li-icon ic-red">${icon('trash')}</span><span class="li-body"><strong>${esc(t('channel.delete'))}</strong><small>${esc(t('channel.delete_hint'))}</small></span></button></div>`;
    page.el.addEventListener('click', async event => {
      if (event.target.closest('[data-transfer]')) {
        const candidates = (conv.participants || []).filter(u => u.id !== state.user.id);
        const s = PU.sheet({ title: t('channel.transfer'), body: `<form class="form"><label class="field"><span>${esc(t('channel.new_owner'))}</span><select name="user_id">${candidates.map(u => `<option value="${u.id}">${esc(u.name)} (@${esc(u.username)})</option>`).join('')}</select></label><label class="field"><span>${esc(t('auth.current_password'))}</span><input type="password" name="password" required autocomplete="current-password"></label><p class="hint" style="padding:0">${esc(t('channel.transfer_warning'))}</p><button class="btn danger block" type="submit">${esc(t('channel.transfer'))}</button></form>` });
        s.el.addEventListener('submit', async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          try { P.retainConversation(await P.post('channels.transfer', { conversation_id: conv.id, user_id: Number(f.get('user_id')), password: f.get('password') })); s.close(); page.close(); P.toast(t('channel.transferred'), 'success'); }
          catch (error) { P.failed(error); }
        });
      }
      if (event.target.closest('[data-archive-community]')) {
        if (!await PU.confirm({ title: t(conv.community_archived ? 'channel.unarchive' : 'channel.archive'), text: t('channel.archive_hint'), confirm: t('common.confirm') })) return;
        try { P.retainConversation(await P.post('channels.archive', { conversation_id: conv.id, archived: !conv.community_archived })); page.close(); }
        catch (error) { P.failed(error); }
      }
      if (event.target.closest('[data-delete-community]')) {
        const s = PU.sheet({ title: t('channel.delete'), body: `<form class="form"><p class="pu-confirm-text">${esc(t('channel.delete_warning', { name: conv.name }))}</p><label class="field"><span>${esc(t('channel.type_name'))}</span><input name="confirm_name" required autocomplete="off" placeholder="${esc(conv.name)}"></label><label class="field"><span>${esc(t('auth.current_password'))}</span><input type="password" name="password" required autocomplete="current-password"></label><button class="btn danger block" type="submit">${esc(t('channel.delete_forever'))}</button></form>` });
        s.el.addEventListener('submit', async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          try { await P.post('channels.delete', { conversation_id: conv.id, confirm_name: f.get('confirm_name'), password: f.get('password') }); s.close(); page.close(); P.removeConversation(conv.id); P.toast(t('channel.deleted'), 'success'); }
          catch (error) { P.failed(error); }
        });
      }
    });
  }

  /* ---------- Comment threads ---------- */
  let thread = null;
  window.PingUpThread = {
    async open(root, conv) {
      if (!root || !conv) return;
      const s = PU.sheet({ title: t('channel.comments'), full: true, className: 'thread', body: `<div class="thread-root">${P.messagePreview(root) ? esc(P.messagePreview(root)) : ''}</div><div class="messages-list" data-thread-list>${loading}</div>`, footer: conv.community_archived ? '' : `<form class="composer" data-thread-form style="width:100%"><div class="composer-field"><textarea rows="1" maxlength="4000" placeholder="${esc(t('channel.comment_placeholder'))}" data-thread-input></textarea></div><button class="send-btn" type="submit" aria-label="${esc(t('common.send'))}">${icon('send')}</button></form>`, onClose: () => { clearInterval(thread?.timer); thread = null; } });
      thread = { root, conv, sheet: s, last: 0, authors: new Map(), timer: null, reply: null };
      const load = async () => {
        try {
          const data = await P.api('messages.thread', { message_id: root.id, after_id: thread.last });
          for (const a of data.authors) thread.authors.set(a.id, a);
          if (!thread.last) $('[data-thread-list]', s.el).innerHTML = data.comments.length ? '' : `<p class="hint" data-thread-empty>${esc(t('channel.no_comments'))}</p>`;
          for (const c of data.comments) window.PingUpThread.receive(c);
        } catch (error) { if (!thread.last) $('[data-thread-list]', s.el).innerHTML = errorBlock(error); }
      };
      await load();
      thread.timer = setInterval(load, 4000);
      s.el.addEventListener('submit', async event => {
        event.preventDefault();
        const input = $('[data-thread-input]', s.el), text = input.value.trim();
        if (!text) return;
        input.value = '';
        try {
          const comment = await P.post('messages.send', { conversation_id: conv.id, thread_root_id: root.id, text, reply_to: thread.reply?.id, client_id: 'c:' + (crypto.randomUUID?.() || Date.now()) });
          thread.reply = null;
          window.PingUpThread.receive(comment);
          root.comment_count = (root.comment_count || 0) + 1;
          window.PingUpChat?.insertMessage(root, { animate: false });
        } catch (error) { input.value = text; P.failed(error); }
      });
      s.el.addEventListener('keydown', event => { if (event.target.matches('[data-thread-input]') && event.key === 'Enter' && !event.shiftKey && !PU.isMobile()) { event.preventDefault(); $('[data-thread-form]', s.el).requestSubmit(); } });
      s.el.addEventListener('click', async event => {
        const react = event.target.closest('[data-thread-react]');
        if (react) { try { window.PingUpThread.receive(await P.post('messages.react', { message_id: Number(react.dataset.threadReact), emoji: react.dataset.emoji })); } catch (error) { P.failed(error); } }
        const reply = event.target.closest('[data-thread-reply]');
        if (reply) { thread.reply = { id: Number(reply.dataset.threadReply) }; $('[data-thread-input]', s.el).focus(); $('[data-thread-input]', s.el).placeholder = t('chat.reply_to_name', { name: reply.dataset.name }); }
        const del = event.target.closest('[data-thread-delete]');
        if (del && await PU.confirm({ title: t('delete.title'), confirm: t('delete.confirm'), danger: true })) {
          try { await P.post('messages.delete', { message_id: Number(del.dataset.threadDelete), scope: 'everyone' }); del.closest('.msg')?.remove(); } catch (error) { P.failed(error); }
        }
      });
    },
    receive(m) {
      if (!thread || Number(m.thread_root_id) !== Number(thread.root.id)) return;
      const listEl = $('[data-thread-list]', thread.sheet.el);
      if (!listEl) return;
      $('[data-thread-empty]', listEl)?.remove();
      thread.last = Math.max(thread.last, Number(m.id));
      const author = thread.authors.get(m.sender_id) || (m.sender_id === state.user.id ? state.user : { name: t('common.unknown'), id: m.sender_id });
      const own = Number(m.sender_id) === Number(state.user.id);
      const canDelete = own || thread.conv.permissions?.moderate_comments;
      const html = m.deleted || m.hidden ? '' : `<div class="msg ${own ? 'own' : ''}" data-comment="${m.id}"><span class="msg-avatar">${P.avatar(author, 'sm')}</span><div class="msg-col"><div class="bubble"><div class="msg-sender">${esc(author.name)}${P.badges(author)}</div>${m.reply ? `<div class="msg-reply"><strong>${esc(m.reply.sender_name || '')}</strong><span>${esc(P.messagePreview(m.reply))}</span></div>` : ''}<div class="msg-text">${PU.format(m.text)}<span class="msg-meta"><time>${esc(P.shortTime(m.created_at))}</time></span></div></div><div class="msg-reactions">${(m.reactions || []).map(r => `<button class="reaction ${r.mine ? 'mine' : ''}" data-thread-react="${m.id}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)}<span>${r.count}</span></button>`).join('')}<button class="reaction" data-thread-react="${m.id}" data-emoji="❤️" aria-label="❤️">♡</button><button class="reaction" data-thread-reply="${m.id}" data-name="${esc(author.name)}">${icon('reply')}</button>${canDelete ? `<button class="reaction" data-thread-delete="${m.id}" aria-label="${esc(t('delete.title'))}">${icon('trash')}</button>` : ''}</div></div></div>`;
      const existing = $(`[data-comment="${m.id}"]`, listEl);
      if (existing) { if (html) existing.outerHTML = html; else existing.remove(); return; }
      if (!html) return;
      listEl.insertAdjacentHTML('beforeend', html);
      PU.animateIn(listEl.lastElementChild);
      const body = $('.pu-sheet-body', thread.sheet.el);
      body.scrollTop = body.scrollHeight;
    },
  };

  /* ---------- Events ---------- */
  document.addEventListener('click', async event => {
    const el = event.target.closest('button,a');
    if (!el) return;
    const d = el.dataset;
    if (d.newCommunity) { Pages.newCommunity(d.newCommunity); return; }
    if (d.directUser) { startDirect(d.directUser); return; }
    if (d.callUser || d.videoUser) { const id = Number(d.callUser || d.videoUser); const user = state.contacts.find(u => u.id === id) || await P.api('users.profile', { user_id: id }).catch(() => null); if (user) window.PingUpCalls?.start(user, d.videoUser ? 'video' : 'audio'); return; }
    if (d.communityInfo) {
      const id = Number(d.communityInfo);
      if (P.findConversation(id)) Pages.communityInfo(id); else joinPublic(id);
      return;
    }
    if (d.joinPublic) { joinPublic(Number(d.joinPublic)); return; }
    if (d.discoverCategory) { $$('[data-discover-category]').forEach(b => b.classList.toggle('active', b === el)); discover($('#discover-search')?.value || '', d.discoverCategory); return; }
    if (d.contactsTab) { contactsTab = d.contactsTab; $$('[data-contacts-tab]').forEach(b => b.classList.toggle('active', b === el)); renderContacts(); return; }
    if (d.contactAccept) { contactAction('contacts.respond', d.contactAccept, { accept: true }); return; }
    if (d.contactDecline) { contactAction('contacts.respond', d.contactDecline, { accept: false }); return; }
    if (d.contactCancel) { contactAction('contacts.cancel', d.contactCancel); return; }
    if (d.unblock) { contactAction('users.unblock', d.unblock); return; }
    if (el.hasAttribute('data-add-contact')) { Pages.search('', { type: 'people' }); return; }
    if (el.hasAttribute('data-new-call')) { Pages.newCall(); return; }
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'discover-search') discover(event.target.value, $('[data-discover-category].active')?.dataset.discoverCategory || 'all');
    if (event.target.id === 'contacts-search') renderContacts();
  });
})();
