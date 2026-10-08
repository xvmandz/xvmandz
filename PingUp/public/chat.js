'use strict';
/* PingUp chat screen: message list, statuses, composer, attachments, reactions, gestures, threads, polls. */
(() => {
  const { $, $$, esc, icon } = PU;
  const P = window.PingUp, state = P.state, t = P.t;
  const EMOJI = {
    smileys: '😀 😃 😄 😁 😆 🥹 😂 🤣 😊 😇 🙂 😉 😌 😍 🥰 😘 😗 😋 😛 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🫢 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👻 💀 🤖 👽 🎃 😺 😸 😹 😻'.split(' '),
    gestures: '👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💪 🦾 👀 🧠 🫀 👂 👃 💋'.split(' '),
    hearts: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💟 ✨ 🔥 💯 💥 💫 ⭐ 🌟 ⚡ 🌈 ☀️ 🌙 ❄️ 🎉 🎊 🎁 🏆 🥇 🎯 🎮 🎧 🎵 🎶 📸 💡 📌 📎 ✅ ❌ ⚠️ ❓ ❗ 💬 💭 🕐'.split(' '),
    nature: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐍 🐙 🐬 🐳 🌵 🌲 🌴 🌱 🌿 🍀 🍁 🌸 🌹 🌻 🌷 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥑 🍕 🍔 🍟 🌮 🍣 🍩 🍪 🎂 ☕ 🍵 🍺 🥂'.split(' '),
    travel: '🚗 🚕 🚌 🏎 🚓 🚑 🚒 🚲 🛴 🏍 ✈️ 🚀 🛸 🚁 ⛵ 🚢 🗺 🏔 🏕 🏖 🏝 🏠 🏢 🏰 🗼 🗽 🌍 🌎 🌏 🇺🇦 🏳️‍🌈 🏁 ⚽ 🏀 🏈 🎾 🏐 🎱 🏓 🥊 ⛳ 🎿 🏂'.split(' '),
  };
  const QUICK_DEFAULT = ['❤️', '👍', '🔥', '😂', '🥹', '✨'];
  const chat = {
    screen: null, conv: null, abort: null, observer: null, olderObserver: null, readCandidate: 0, readTimer: null, layer: null,
    reply: null, edit: null, attachments: [], selecting: false, selected: new Set(), pinIndex: 0, newCount: 0,
    recorder: null, recordStream: null, recordTimer: null, recordStart: 0, panel: null, stickers: null, loadingOlder: false, hasMore: false,
  };
  let typingSent = 0, typingTimer = null, draftTimer = null;

  /* ---------- Status of own messages ---------- */
  function deliveryStatus(m, conv = P.findConversation(m.conversation_id)) {
    if (m.pending) return 'sending';
    if (m.failed) return 'failed';
    if (!conv || conv.type === 'saved') return 'read';
    const id = Number(m.id);
    if (Number(conv.peer_read) >= id) return 'read';
    if (Number(conv.peer_delivered) >= id) return 'delivered';
    return 'sent';
  }
  function ticksHTML(m, conv) {
    const status = deliveryStatus(m, conv);
    const name = status === 'sending' ? 'clock' : status === 'failed' ? 'alert' : status === 'sent' ? 'check' : 'checks';
    return `<span class="ticks ${status}" data-status="${status}" title="${esc(t(`status.${status}`))}" aria-label="${esc(t(`status.${status}`))}">${icon(name)}</span>`;
  }

  /* ---------- Message rendering ---------- */
  const isOwn = m => Number(m.sender_id) === Number(state.user.id);
  const msgs = (id = state.active) => state.messages.get(Number(id)) || new Map();
  function sender(m, conv = chat.conv) {
    return m.sender || conv?.participants?.find(u => Number(u.id) === Number(m.sender_id)) || { id: m.sender_id, name: t('common.unknown'), username: String(m.sender_id) };
  }
  function docIcon(file) {
    const ext = String(file.name || '').split('.').pop().toUpperCase().slice(0, 4);
    const cls = file.kind === 'pdf' ? 'pdf' : file.kind === 'archive' ? 'archive' : '';
    return `<span class="doc-icon ${cls}">${icon(file.kind === 'archive' ? 'archive' : 'file')}<b>${esc(ext)}</b></span>`;
  }
  function mediaItem(file, index, total) {
    const url = esc(file.url);
    if (file.kind === 'video') return `<button class="media-btn video-wrap" data-view-media="${file.id}" aria-label="${esc(file.name)}"><video src="${url}#t=0.1" preload="metadata" muted playsinline></video><span class="play-overlay"><span>${icon('play')}</span></span>${index === 3 && total > 4 ? `<span class="more-count">+${total - 4}</span>` : ''}</button>`;
    return `<button class="media-btn" data-view-media="${file.id}" aria-label="${esc(file.name)}"><img src="${url}" alt="${esc(file.name)}" loading="lazy" decoding="async">${index === 3 && total > 4 ? `<span class="more-count">+${total - 4}</span>` : ''}</button>`;
  }
  function fileBlock(m) {
    const f = m.file;
    if (!f) return '';
    if (m.kind === 'voice') return PU.audioMarkup(f, true);
    if (f.kind === 'image' || f.kind === 'video') return `<div class="msg-media">${mediaItem(f, 0, 1)}</div>`;
    if (f.kind === 'audio') return PU.audioMarkup(f, false);
    const preview = f.kind === 'pdf' ? `<button class="icon-btn" data-pdf-preview="${f.id}" data-url="${esc(f.url)}" aria-label="${esc(t('media.preview'))}">${icon('eye')}</button>` : '';
    return `<div class="doc-card">${docIcon(f)}<span class="doc-body"><strong>${esc(f.name)}</strong><small>${esc(P.fileSize(f.size))} · ${esc(String(f.name).split('.').pop().toUpperCase())}</small></span><span class="doc-actions">${preview}<a class="icon-btn" href="${esc(f.url)}&download=1" download aria-label="${esc(t('media.download'))}">${icon('download')}</a></span></div>`;
  }
  function pollBlock(m) {
    const poll = m.poll;
    if (!poll) return '';
    const total = poll.total_voters || 0, showResults = poll.voted || poll.closed;
    const options = poll.options.map(o => {
      const pct = total ? Math.round(o.votes / total * 100) : 0;
      return `<button class="poll-option ${o.mine ? 'mine selected' : ''}" data-poll-option="${o.id}" data-message="${m.id}" ${poll.closed ? 'disabled' : ''}><i class="bar" style="width:${showResults ? pct : 0}%"></i><i class="mark"></i><span>${esc(o.text)}</span>${showResults ? `<b>${pct}%</b>` : ''}</button>`;
    }).join('');
    return `<div class="poll ${poll.multiple ? 'multiple' : ''}" data-poll="${m.id}"><h4>${esc(poll.question)}</h4><small>${esc(t(poll.anonymous ? 'poll.anonymous' : 'poll.public'))}${poll.multiple ? ' · ' + esc(t('poll.multiple')) : ''}${poll.closed ? ' · ' + esc(t('poll.closed')) : ''}</small>${options}<small>${esc(t('poll.voters', { count: total }))}</small>${poll.multiple && !poll.closed ? `<button class="btn small" data-poll-submit="${m.id}">${esc(t('poll.vote'))}</button>` : ''}${!poll.anonymous && total ? `<button class="text-btn" data-poll-voters="${m.id}">${esc(t('poll.show_voters'))}</button>` : ''}</div>`;
  }
  function callBlock(m) {
    const call = m.call, missed = !['completed', undefined].includes(call.reason) && call.status === 'ended' && call.incoming;
    const duration = call.duration ? ` · ${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, '0')}` : '';
    return `<button class="call-card chat-call-card ${missed ? 'missed' : ''} ${call.status === 'active' ? 'live' : ''}" data-redial="${call.peer_id}" data-call-kind="${call.kind}"><span class="call-ico">${icon(call.kind === 'video' ? 'video' : 'phone')}</span><div><strong>${esc(P.callLabel(call))}</strong><small>${esc(t(call.kind === 'video' ? 'calls.video' : 'calls.audio'))}${duration}</small></div></button>`;
  }
  function linkCard(text) {
    const url = PU.firstUrl(text);
    // Domain card only: the server never fetches arbitrary URLs (no SSRF, no tracking of the reader).
    return url ? `<div class="link-card">${icon('link')}<span><strong>${esc(url.hostname.replace(/^www\./, ''))}</strong><br>${esc(url.pathname.length > 1 ? decodeURIComponent(url.pathname).slice(0, 60) : t('chat.open_link'))}</span></div>` : '';
  }
  function bubbleInner(m) {
    const conv = chat.conv;
    if (m.deleted) return `<div class="msg-deleted">${esc(t('message.deleted'))}</div>`;
    if (m.call) return callBlock(m);
    if (m.kind === 'sticker' && m.sticker) return `<button class="sticker" data-sticker-pack="${m.id}"><img src="${esc(m.sticker.url)}" alt="${esc(m.sticker.emoji || t('chat.sticker'))}" loading="lazy"></button>`;
    const parts = [];
    const showSender = !isOwn(m) && conv?.type === 'group';
    if (showSender) { const s = sender(m); parts.push(`<div class="msg-sender">${esc(s.name)}${P.badges(s)}</div>`); }
    if (m.forward) parts.push(`<div class="msg-forward">${icon('forward')}${esc(t('message.forwarded_from', { name: m.forward.name }))}</div>`);
    else if (m.forwarded) parts.push(`<div class="msg-forward">${icon('forward')}${esc(t('message.forwarded'))}</div>`);
    if (m.reply) parts.push(`<button class="msg-reply" data-jump-message="${Number(m.reply.id)}"><strong>${esc(m.reply.sender_name || sender({ sender_id: m.reply.sender_id }).name)}</strong><span>${esc(P.messagePreview(m.reply))}</span></button>`);
    else if (m.reply_to) parts.push(`<div class="msg-reply"><span>${esc(t('message.reply_missing'))}</span></div>`);
    if (m.kind === 'album' && m.files?.length) {
      const visible = m.files.slice(0, 4);
      parts.push(`<div class="msg-media album n${visible.length}">${visible.map((f, i) => mediaItem(f, i, m.files.length)).join('')}</div>`);
    } else parts.push(fileBlock(m));
    if (m.poll) parts.push(pollBlock(m));
    if (m.text) parts.push(`<div class="msg-text message-text" dir="auto">${PU.format(m.text)}${metaHTML(m)}</div>${linkCard(m.text)}`);
    else parts.push(`<div class="msg-text message-text">${metaHTML(m)}</div>`);
    if (conv?.type === 'channel' && !m.thread_root_id) {
      if (conv.settings?.show_author !== false && !isOwn(m)) parts.push(`<div class="post-author">${esc(sender(m).name)}</div>`);
      if (conv.settings?.comments_enabled) parts.push(`<button class="post-comments" data-open-thread="${m.id}">${icon('comment')}<span>${esc(m.comment_count ? t('channel.comments_count', { count: m.comment_count }) : t('channel.leave_comment'))}</span>${icon('chevron')}</button>`);
    }
    return parts.join('');
  }
  function metaHTML(m) {
    const conv = chat.conv;
    const views = conv?.type === 'channel' && !m.thread_root_id && m.views ? `<span class="views">${icon('eye')}${m.views > 999 ? (m.views / 1000).toFixed(1) + 'K' : m.views}</span>` : '';
    return `<span class="msg-meta">${m.starred ? `<span class="star-mark">${icon('star')}</span>` : ''}${m.pinned ? `<span class="pin-mark">${icon('pin')}</span>` : ''}${views}${m.edited ? `<span>${esc(t('message.edited'))}</span>` : ''}<time>${esc(P.shortTime(m.created_at))}</time>${isOwn(m) && conv?.type !== 'channel' ? ticksHTML(m, conv) : ''}</span>`;
  }
  function reactionsHTML(m) {
    return (m.reactions || []).map(r => `<button class="reaction ${r.mine ? 'mine' : ''}" data-react="${esc(r.emoji)}" data-message="${esc(m.id)}" ${m.pending || m.failed ? 'disabled' : ''}>${esc(r.emoji)}<span>${Number(r.count) || 1}</span></button>`).join('');
  }
  function messageClasses(m) {
    const mediaOnly = !m.text && !m.deleted && (m.kind === 'album' || (m.file && ['image', 'video'].includes(m.file.kind))) && !m.reply && !m.forwarded;
    return ['msg', 'message-group', isOwn(m) ? 'own' : '', m.pending ? 'pending' : '', m.failed ? 'failed' : '', m.call ? 'call-log' : '', mediaOnly ? 'media-only' : '', m.kind === 'sticker' ? 'sticker-msg' : ''].filter(Boolean).join(' ');
  }
  function messageHTML(m) {
    const conv = chat.conv, showAvatar = !isOwn(m) && conv?.type === 'group';
    return `<div class="${messageClasses(m)}" data-message-id="${esc(m.id)}" ${m.client_id ? `data-client-id="${esc(m.client_id)}"` : ''} data-sender="${Number(m.sender_id)}" data-day="${new Date(Number(m.created_at) * 1000 || Date.parse(m.created_at)).toDateString()}"><span class="swipe-hint">${icon('reply')}</span>${showAvatar ? `<button class="msg-avatar" data-profile="${Number(m.sender_id)}" aria-label="${esc(sender(m).name)}">${P.avatar(sender(m), 'sm')}</button>` : ''}<div class="msg-col"><div class="bubble">${bubbleInner(m)}</div><div class="msg-reactions">${reactionsHTML(m)}</div>${m.failed ? `<button class="retry" data-retry-message="${esc(m.client_id)}">${icon('refresh')}${esc(t('chat.retry_send'))}</button>` : ''}</div><div class="msg-tools">${!m.pending && !m.failed ? `<button class="icon-btn" data-reply="${m.id}" aria-label="${esc(t('chat.reply'))}">${icon('reply')}</button><button class="icon-btn" data-message-menu="${m.id}" aria-label="${esc(t('chat.actions'))}">${icon('more')}</button>` : ''}</div></div>`;
  }
  const bodySig = m => JSON.stringify([m.text, m.file?.id, m.files?.map(f => f.id), m.reply, m.forward, m.forwarded, m.call, m.deleted, m.poll, m.sticker?.id, m.comment_count, m.views, m.edited, m.pinned, m.starred, m.pending, m.failed, deliveryStatus(m), chat.conv?.settings?.comments_enabled]);

  function list() { return $('.messages-list', chat.screen || document); }
  function elFor(m) {
    const listEl = list();
    if (!listEl) return null;
    return listEl.querySelector(`[data-message-id="${CSS.escape(String(m.id))}"]`) || (m.client_id ? listEl.querySelector(`[data-client-id="${CSS.escape(m.client_id)}"]`) : null);
  }
  function insertMessage(m, { animate = true, prepend = false } = {}) {
    const listEl = list();
    if (!listEl || Number(m.conversation_id) !== Number(state.active) || m.thread_root_id) return;
    const existing = elFor(m);
    // Messages deleted for everyone or hidden for this account leave the list, as in 2.0.
    if (m.hidden || m.deleted) { if (existing) removeEl(existing); return; }
    const sig = bodySig(m) + JSON.stringify(m.reactions) + messageClasses(m);
    if (existing && existing.dataset.sig === sig) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = messageHTML(m);
    const fresh = tpl.content.firstElementChild;
    fresh.dataset.sig = sig;
    if (existing) {
      // Keep the node (and any playing audio/video) alive; only patch what changed.
      const wasPending = existing.classList.contains('pending');
      const keep = [...existing.classList].filter(c => ['grouped', 'grouped-next', 'selected', 'highlight'].includes(c));
      existing.className = fresh.className;
      keep.forEach(c => existing.classList.add(c));
      existing.dataset.messageId = String(m.id);
      existing.dataset.sig = sig;
      if (m.client_id) existing.dataset.clientId = m.client_id;
      const oldBubble = $('.bubble', existing), newBubble = $('.bubble', fresh);
      if (existing.dataset.body !== bodySig(m)) {
        const audio = $('.pu-audio', oldBubble), nextAudio = $('.pu-audio', newBubble);
        if (audio && nextAudio && audio.dataset.src === nextAudio.dataset.src) nextAudio.replaceWith(audio);
        const oldTicks = $('.ticks', oldBubble), newTicks = $('.ticks', newBubble);
        if (oldTicks && newTicks && oldTicks.dataset.status !== newTicks.dataset.status) newTicks.classList.add('bump');
        oldBubble.replaceChildren(...newBubble.childNodes);
        existing.dataset.body = bodySig(m);
        if (m.edited && !wasPending && existing.dataset.wasEdited !== '1') { existing.dataset.wasEdited = '1'; PU.animateIn(existing, 'edited-flash'); }
      }
      const oldReactions = $('.msg-reactions', existing), newReactions = $('.msg-reactions', fresh);
      if (oldReactions.innerHTML !== newReactions.innerHTML) {
        const before = new Set($$('.reaction', oldReactions).map(r => r.dataset.react));
        oldReactions.replaceWith(newReactions);
        $$('.reaction', newReactions).forEach(r => { if (!before.has(r.dataset.react)) PU.animateIn(r); });
      }
      $('.msg-tools', existing).replaceWith($('.msg-tools', fresh));
      $('.retry', existing)?.remove();
      const retry = $('.retry', fresh);
      if (retry) $('.msg-col', existing).append(retry);
      return;
    }
    fresh.dataset.body = bodySig(m);
    if (prepend) listEl.prepend(fresh);
    else {
      // Keep chronological order even when an older message arrives late.
      const after = $$('.msg', listEl).reverse().find(el => Number(el.dataset.messageId) && Number(el.dataset.messageId) < Number(m.id));
      const pendingFirst = $('.msg.pending,.msg.failed', listEl);
      if (!String(m.id).startsWith('pending') && pendingFirst && (!after || after.compareDocumentPosition(pendingFirst) & Node.DOCUMENT_POSITION_FOLLOWING)) listEl.insertBefore(fresh, pendingFirst);
      else if (after && after.nextElementSibling && !String(m.id).startsWith('pending')) after.after(fresh);
      else listEl.append(fresh);
    }
    if (animate) PU.animateIn(fresh);
    if (!isOwn(m) && !m.pending) chat.observer?.observe(fresh);
  }
  function removeEl(el) {
    chat.observer?.unobserve(el);
    if (PU.reducedMotion()) { el.remove(); relayout(); return; }
    el.classList.add('leaving');
    setTimeout(() => { el.remove(); relayout(); }, 200);
  }
  /* Grouping of consecutive messages and day separators, recalculated in one pass. */
  function relayout() {
    const listEl = list();
    if (!listEl) return;
    $$('.day-sep,.unread-sep', listEl).forEach(el => el.remove());
    const items = $$('.msg', listEl);
    let prev = null;
    const map = msgs();
    const conv = chat.conv;
    const firstUnread = chat.unreadMarker;
    for (const el of items) {
      const m = map.get(Number(el.dataset.messageId)) || map.get(el.dataset.messageId);
      const same = prev && prev.dataset.sender === el.dataset.sender && prev.dataset.day === el.dataset.day && !el.classList.contains('call-log') && !prev.classList.contains('call-log');
      el.classList.toggle('grouped', !!same);
      if (prev) prev.classList.toggle('grouped-next', !!same);
      if (!prev || prev.dataset.day !== el.dataset.day) {
        const sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.textContent = m ? P.dayLabel(m.created_at) : el.dataset.day;
        el.before(sep);
      }
      if (firstUnread && Number(el.dataset.messageId) === firstUnread) {
        const sep = document.createElement('div');
        sep.className = 'unread-sep';
        sep.textContent = t('chat.unread_messages');
        el.before(sep);
      }
      prev = el;
    }
    if (prev) prev.classList.remove('grouped-next');
    if (conv?.type === 'channel') items.forEach(el => el.classList.remove('grouped'));
  }
  function upsert(messages, { animate = true } = {}) {
    if (!state.active) return;
    const id = Number(state.active);
    if (!state.messages.has(id)) state.messages.set(id, new Map());
    const map = state.messages.get(id);
    const near = isNearBottom();
    let added = 0;
    for (const m of messages || []) {
      if (Number(m.conversation_id) !== id) continue;
      if (m.thread_root_id) { window.PingUpThread?.receive(m); continue; }
      const had = map.has(m.id);
      if (m.client_id) for (const [key, p] of map) if (p.client_id === m.client_id && (p.pending || p.failed) && key !== m.id) { map.delete(key); window.PingUpExperience?.ack(m.client_id); }
      map.set(m.id, m);
      if (!had && !m.pending) added++;
      insertMessage(m, { animate: animate && !had });
    }
    relayout();
    updatePins();
    if (added) {
      if (near) scrollBottom(true);
      else { chat.newCount += added; updateJump(); }
    }
  }

  /* ---------- Scrolling ---------- */
  const area = () => $('.messages', chat.screen || document);
  function isNearBottom() { const a = area(); return !a || a.scrollHeight - a.scrollTop - a.clientHeight < 160; }
  function scrollBottom(smooth) {
    const a = area();
    if (!a) return;
    requestAnimationFrame(() => a.scrollTo({ top: a.scrollHeight, behavior: smooth && !PU.reducedMotion() ? 'smooth' : 'auto' }));
  }
  function updateJump() {
    const button = $('.jump-down', chat.screen);
    if (!button) return;
    const show = !isNearBottom();
    button.classList.toggle('hidden-btn', !show);
    const badge = $('.badge', button);
    if (chat.newCount && show) { if (badge) badge.textContent = chat.newCount; else button.insertAdjacentHTML('beforeend', `<b class="badge">${chat.newCount}</b>`); }
    else badge?.remove();
    if (!show) chat.newCount = 0;
  }
  /* Scrolls only the message log (scrollIntoView would also move clipped ancestors). */
  function scrollToEl(el, block = 'center') {
    const a = area();
    if (!a || !el) return;
    const top = el.getBoundingClientRect().top - a.getBoundingClientRect().top + a.scrollTop;
    a.scrollTo({ top: block === 'start' ? top - 8 : top - a.clientHeight / 2 + el.offsetHeight / 2, behavior: PU.reducedMotion() || block === 'start' ? 'auto' : 'smooth' });
  }
  function jumpTo(id) {
    const el = $(`[data-message-id="${CSS.escape(String(id))}"]`, chat.screen);
    if (el) {
      scrollToEl(el, 'center');
      el.classList.remove('highlight');
      void el.offsetWidth;
      el.classList.add('highlight');
      setTimeout(() => el.classList.remove('highlight'), 1700);
      return;
    }
    loadAround(id);
  }
  async function loadAround(id) {
    const conversationId = state.active;
    try {
      const data = await P.api('messages.list', { conversation_id: conversationId, around_id: id, limit: 40 });
      if (state.active !== conversationId) return;
      list().replaceChildren();
      state.messages.set(Number(conversationId), new Map());
      upsert(data.messages, { animate: false });
      chat.hasMore = data.has_more;
      setTimeout(() => jumpTo(id), 50);
    } catch (error) { P.failed(error); }
  }

  /* ---------- Opening / closing ---------- */
  function headerStatus(conv) {
    const typing = state.typing.get(Number(conv.id));
    if (typing?.length) return `<span class="typing-dots"><i></i><i></i><i></i></span>${esc(P.typingText(typing, conv))}`;
    if (conv.type === 'direct') return esc(P.lastSeen(P.peer(conv)));
    if (conv.type === 'saved') return esc(t('chat.saved_hint'));
    if (conv.member_count === null) return esc(t(conv.type === 'channel' ? 'channel.channel' : 'chat.group'));
    return esc(t(conv.type === 'channel' ? 'channel.subscribers' : 'chat.participants', { count: conv.member_count || 0 }));
  }
  function headerHTML(conv) {
    const direct = conv.type === 'direct', peerUser = P.peer(conv);
    const canCall = direct && peerUser && Number(peerUser.id) !== Number(state.user.id);
    return `<header class="chat-head"><button class="icon-btn" data-action="chat-back" aria-label="${esc(t('common.back'))}">${icon('back')}</button><button class="chat-title chat-person" data-action="chat-info">${P.convAvatar(conv, 'sm')}<span class="chat-title-text"><strong><span>${esc(P.convName(conv))}</span>${direct ? P.badges(peerUser) : ''}</strong><span class="chat-status ${state.typing.get(Number(conv.id))?.length ? 'live' : ''}">${headerStatus(conv)}</span></span></button><div class="actions">${canCall ? `<button class="icon-btn desktop-only" data-action="call" aria-label="${esc(t('chat.call'))}">${icon('phone')}</button><button class="icon-btn desktop-only" data-action="video-call" aria-label="${esc(t('calls.video'))}">${icon('video')}</button>` : ''}<button class="icon-btn desktop-only" data-action="chat-search" aria-label="${esc(t('chat.search_messages'))}">${icon('search')}</button><button class="icon-btn" data-action="chat-menu" aria-label="${esc(t('chat.more'))}">${icon('vmore')}</button></div></header>`;
  }
  function composerHTML(conv) {
    if (conv.community_archived) return `<div class="composer-wrap"><div class="readonly-bar channel-readonly">${icon('archive')}<span>${esc(t('channel.archived_readonly'))}</span></div></div>`;
    if (!conv.permissions?.post) {
      const muted = conv.notification_mode === 'none';
      return `<div class="composer-wrap"><div class="readonly-bar channel-readonly"><button class="btn block" data-action="toggle-mute">${icon(muted ? 'bell' : 'bellOff')}${esc(t(muted ? 'channel.unmute' : 'channel.mute'))}</button></div></div>`;
    }
    const draft = state.drafts.get(Number(conv.id)) || { text: conv.draft || '' };
    return `<div class="composer-wrap"><button class="jump-down hidden-btn" data-action="jump-down" aria-label="${esc(t('chat.jump_bottom'))}">${icon('down')}</button><div class="composer-extra"></div><div class="attach-tray" hidden></div><form class="composer" id="message-form" autocomplete="off"><div class="composer-field"><button type="button" class="icon-btn" data-action="emoji-panel" aria-label="${esc(t('chat.emoji'))}">${icon('smile')}</button><textarea id="message-input" rows="1" maxlength="10000" placeholder="${esc(t(conv.type === 'channel' ? 'channel.post_placeholder' : 'chat.message_placeholder'))}" aria-label="${esc(t('chat.message_placeholder'))}" enterkeyhint="send">${esc(draft.text || '')}</textarea><button type="button" class="icon-btn" data-action="attach-menu" aria-label="${esc(t('chat.attachment'))}">${icon('attach')}</button></div><button type="submit" class="send-btn" aria-label="${esc(t('common.send'))}" data-mode="mic">${icon('mic')}</button></form></div>`;
  }
  function applyChannelSkin(conv) {
    const screen = chat.screen;
    screen.classList.toggle('channel-skin', conv.type === 'channel' && !conv.own_theme);
    if (conv.type !== 'channel' || conv.own_theme) { screen.removeAttribute('data-preset'); screen.removeAttribute('data-card'); screen.style.cssText = ''; return; }
    const s = conv.settings || {};
    screen.dataset.preset = s.preset || 'classic';
    screen.dataset.card = s.card_style || 'elevated';
    const vars = [];
    if (s.accent) vars.push(`--ch-accent:${s.accent}`);
    if (s.header_color) vars.push(`--ch-header:${s.header_color}`);
    if (s.button_color) vars.push(`--ch-button:${s.button_color}`);
    if (s.gradient) vars.push(`--ch-bg:linear-gradient(${s.gradient.angle}deg,${s.gradient.from}33,${s.gradient.to}33)`);
    else if (s.background) vars.push(`--ch-bg:${s.background}`);
    screen.style.cssText = vars.join(';');
  }
  function buildScreen(conv) {
    const pane = $('#detail-pane');
    if (!pane) return null;
    $('.chat-screen', pane)?.remove();
    const screen = document.createElement('section');
    screen.className = 'chat-screen';
    screen.setAttribute('aria-label', P.convName(conv));
    screen.innerHTML = `${headerHTML(conv)}<button class="pins" hidden></button><div class="messages messages-area" role="log" aria-live="polite" tabindex="0"><div class="older-sentinel"></div><button class="btn small load-older" data-action="older" hidden>${icon('refresh')}${esc(t('chat.older'))}</button><div class="messages-list"></div></div>${composerHTML(conv)}`;
    pane.append(screen);
    chat.screen = screen;
    applyChannelSkin(conv);
    return screen;
  }
  async function open(id, { messageId = null } = {}) {
    id = Number(id);
    if (!state.user) return;
    if (state.page !== 'chats') { P.setPage('chats'); }
    let conv = P.findConversation(id);
    if (!conv) return;
    if (state.active === id && chat.screen?.isConnected) { if (messageId) jumpTo(messageId); return; }
    if (state.active) stash();
    chat.abort?.abort();
    stopRecording(true);
    resetComposerState();
    const controller = new AbortController();
    chat.abort = controller;
    state.active = id;
    chat.conv = conv;
    chat.hasMore = false;
    chat.newCount = 0;
    chat.unreadMarker = 0;
    const screen = buildScreen(conv);
    if (!screen) return;
    $('.app')?.classList.add('chat-open', 'mobile-chat-open');
    requestAnimationFrame(() => screen.classList.add('open'));
    if (!chat.layer) chat.layer = PU.pushLayer(fromHistory => closeScreen(fromHistory), 'chat');
    setupObservers();
    P.updateConversationList();
    const cached = [...msgs(id).values()].filter(m => !m.thread_root_id).sort((a, b) => (Number(a.id) || Infinity) - (Number(b.id) || Infinity));
    for (const m of cached) insertMessage(m, { animate: false });
    relayout();
    updatePins();
    scrollBottom(false);
    autoResize();
    updateSendMode();
    bindScreen(screen);
    try {
      const firstUnread = conv.unread > 0 ? conv.last_read_message_id : 0;
      const data = await P.api('messages.list', firstUnread && conv.unread > 30 ? { conversation_id: id, around_id: firstUnread + 1, limit: 30 } : { conversation_id: id, limit: 50 }, { signal: controller.signal });
      if (state.active !== id) return;
      if (conv.unread > 0) chat.unreadMarker = (data.messages || []).find(m => Number(m.id) > Number(conv.last_read_message_id) && !isOwn(m))?.id || 0;
      upsert(data.messages || [], { animate: false });
      state.changeCursors.set(id, Number(data.change_cursor) || 0);
      chat.pins = data.pinned_messages || [];
      chat.hasMore = !!data.has_more;
      $('.load-older', screen).hidden = !chat.hasMore;
      updatePins();
      if (messageId) jumpTo(messageId);
      else if (chat.unreadMarker) scrollToEl($('.unread-sep', screen), 'start');
      else scrollBottom(false);
      flushRead();
    } catch (error) {
      if (error.name === 'AbortError') return;
      P.failed(error);
      if (!list().children.length) list().innerHTML = P.empty('refresh', t('common.error'), P.errText(error), `<button class="btn" data-action="reload-chat">${esc(t('common.retry'))}</button>`);
    }
  }
  function stash() {
    const input = $('#message-input', chat.screen || document);
    if (state.active && input) state.drafts.set(Number(state.active), { text: input.value });
    const a = area();
    if (state.active && a) state.scroll.set(`chat:${state.active}`, a.scrollTop);
  }
  function close() { if (chat.layer) PU.closeLayer(chat.layer); else closeScreen(); }
  function closeScreen() {
    chat.layer = null;
    stash();
    saveDraftNow();
    chat.abort?.abort();
    stopRecording(true);
    resetComposerState();
    chat.observer?.disconnect();
    chat.olderObserver?.disconnect();
    const screen = chat.screen;
    state.active = null;
    chat.conv = null;
    chat.screen = null;
    $('.app')?.classList.remove('chat-open', 'mobile-chat-open');
    if (screen) {
      screen.classList.remove('open');
      setTimeout(() => screen.remove(), PU.isMobile() && !PU.reducedMotion() ? 260 : 0);
    }
    P.updateConversationList();
  }
  function resetComposerState() {
    for (const item of chat.attachments) { item.controller?.abort(); if (item.preview) URL.revokeObjectURL(item.preview); }
    chat.attachments = [];
    chat.reply = null;
    chat.edit = null;
    chat.panel = null;
    exitSelection();
  }

  /* ---------- Read receipts: only messages actually shown in an active, focused tab ---------- */
  function setupObservers() {
    chat.observer?.disconnect();
    chat.olderObserver?.disconnect();
    chat.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
        const id = Number(entry.target.dataset.messageId);
        if (Number.isFinite(id) && id > chat.readCandidate) chat.readCandidate = id;
        chat.observer.unobserve(entry.target);
      }
      scheduleRead();
    }, { root: null, threshold: [0.6] });
    chat.readCandidate = 0;
  }
  function scheduleRead() { clearTimeout(chat.readTimer); chat.readTimer = setTimeout(flushRead, 350); }
  async function flushRead() {
    if (!state.active || document.hidden || !document.hasFocus()) return;
    const conv = P.currentConversation();
    if (!conv) return;
    // Own messages and messages from before the cursor never need a receipt.
    const candidate = chat.readCandidate;
    if (!candidate || candidate <= Number(conv.last_read_message_id)) {
      const pendingObserved = $$('.msg:not(.own)', chat.screen).length;
      if (!pendingObserved && conv.unread) { conv.unread = 0; P.updateConversationList(); P.updateNavCounts(); }
      return;
    }
    const id = Number(state.active), previous = conv.last_read_message_id, previousUnread = conv.unread;
    conv.last_read_message_id = candidate;
    conv.unread = [...msgs(id).values()].filter(m => !isOwn(m) && Number(m.id) > candidate && !m.deleted).length;
    P.updateConversationList();
    P.updateNavCounts();
    try {
      const fresh = await P.post('conversations.read', { conversation_id: id, last_message_id: candidate });
      window.PingUpExperience?.chatRead(id);
      if (fresh?.id) { const c = P.findConversation(id); if (c) Object.assign(c, { unread: fresh.unread, last_read_message_id: fresh.last_read_message_id }); P.updateConversationList(); P.updateNavCounts(); }
    } catch {
      conv.last_read_message_id = previous;
      conv.unread = previousUnread;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !chat.screen) return;
    // Messages that were on screen while the tab was hidden are observed again.
    $$('.msg:not(.own)', chat.screen).forEach(el => { if (Number(el.dataset.messageId) > Number(chat.conv?.last_read_message_id || 0)) chat.observer?.observe(el); });
  });
  window.addEventListener('focus', () => { if (chat.screen) $$('.msg:not(.own)', chat.screen).forEach(el => { if (Number(el.dataset.messageId) > Number(chat.conv?.last_read_message_id || 0)) chat.observer?.observe(el); }); });

  /* ---------- Older messages ---------- */
  async function loadOlder() {
    if (chat.loadingOlder || !chat.hasMore) return;
    const a = area(), ids = [...msgs().values()].map(m => Number(m.id)).filter(Number.isFinite);
    if (!a || !ids.length) return;
    chat.loadingOlder = true;
    const id = state.active, before = a.scrollHeight, top = a.scrollTop;
    try {
      const data = await P.api('messages.list', { conversation_id: id, before_id: Math.min(...ids), limit: 50 });
      if (state.active !== id) return;
      const map = msgs(id);
      for (const m of [...(data.messages || [])].reverse()) { map.set(m.id, m); insertMessage(m, { animate: false, prepend: true }); }
      relayout();
      a.scrollTop = top + a.scrollHeight - before;
      chat.hasMore = !!data.has_more;
      $('.load-older', chat.screen).hidden = !chat.hasMore;
    } catch (error) { P.failed(error); }
    finally { chat.loadingOlder = false; }
  }

  /* ---------- Pins ---------- */
  function updatePins() {
    const strip = $('.pins', chat.screen);
    if (!strip) return;
    const loaded = [...msgs().values()].filter(m => m.pinned && !m.deleted && !m.hidden);
    const byId = new Map((chat.pins || []).filter(m => !m.deleted).map(m => [m.id, m]));
    for (const m of loaded) byId.set(m.id, m);
    for (const m of msgs().values()) if (!m.pinned) byId.delete(m.id);
    const pins = [...byId.values()].sort((a, b) => Number(b.id) - Number(a.id));
    strip.hidden = !pins.length;
    if (!pins.length) return;
    chat.pinIndex %= pins.length;
    const current = pins[chat.pinIndex];
    strip.dataset.jumpPin = current.id;
    strip.innerHTML = `<span class="pin-bars">${pins.slice(0, 4).map((_, i) => `<i class="${i === Math.min(chat.pinIndex, 3) ? 'active' : ''}"></i>`).join('')}</span><span class="pins-body"><strong>${esc(pins.length > 1 ? t('chat.pinned_n', { index: chat.pinIndex + 1, count: pins.length }) : t('message.pinned'))}</strong><span>${esc(P.messagePreview(current))}</span></span>${icon('pin')}`;
    chat.pinList = pins;
  }

  /* ---------- Composer ---------- */
  function autoResize() {
    const input = $('#message-input', chat.screen || document);
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }
  function hasContent() {
    const input = $('#message-input', chat.screen || document);
    return !!(input?.value.trim() || chat.attachments.length || chat.edit);
  }
  function updateSendMode() {
    const button = $('.send-btn', chat.screen || document);
    if (!button || chat.recorder) return;
    const mode = hasContent() ? 'send' : 'mic';
    if (button.dataset.mode === mode) return;
    button.dataset.mode = mode;
    button.innerHTML = `<span class="swap">${icon(mode === 'send' ? (chat.edit ? 'check' : 'send') : 'mic')}</span>`;
    button.setAttribute('aria-label', t(mode === 'send' ? 'common.send' : 'chat.record'));
  }
  function renderExtra() {
    const extra = $('.composer-extra', chat.screen);
    if (!extra) return;
    let html = '';
    if (chat.edit) html += `<div class="composer-bar">${icon('edit')}<div><strong>${esc(t('chat.editing'))}</strong><span>${esc(P.messagePreview(chat.edit))}</span></div><button type="button" class="icon-btn" data-action="cancel-edit" aria-label="${esc(t('common.cancel'))}">${icon('close')}</button></div>`;
    else if (chat.reply) html += `<div class="composer-bar">${icon('reply')}<div><strong>${esc(t('chat.reply_to_name', { name: sender(chat.reply).name }))}</strong><span>${esc(P.messagePreview(chat.reply))}</span></div><button type="button" class="icon-btn" data-action="clear-reply" aria-label="${esc(t('common.cancel'))}">${icon('close')}</button></div>`;
    if (chat.panel) html += panelHTML();
    extra.innerHTML = html;
  }
  function panelHTML() {
    if (chat.panel === 'stickers') {
      const packs = chat.stickers || [];
      return `<div class="emoji-panel"><div class="panel-tabs"><button class="chip" data-panel="emoji">${esc(t('chat.emoji'))}</button><button class="chip active" data-panel="stickers">${esc(t('chat.stickers'))}</button></div><div class="emoji-grid sticker-grid">${packs.length ? packs.map(p => `<h5>${esc(p.title)}</h5>${p.stickers.map(s => `<button data-send-sticker="${s.id}" aria-label="${esc(s.emoji)}"><img src="${esc(s.url)}" alt="${esc(s.emoji)}" loading="lazy"></button>`).join('')}`).join('') : '<div class="spinner"></div>'}</div></div>`;
    }
    const recent = JSON.parse(P.readPref('pingup.recent_emoji', '[]') || '[]');
    const groups = [['recent', recent], ...Object.entries(EMOJI)].filter(([, list]) => list.length);
    return `<div class="emoji-panel"><div class="panel-tabs"><button class="chip active" data-panel="emoji">${esc(t('chat.emoji'))}</button><button class="chip" data-panel="stickers">${esc(t('chat.stickers'))}</button></div><div class="emoji-grid">${groups.map(([name, list]) => `<h5>${esc(t(`emoji.${name}`))}</h5>${list.map(e => `<button data-insert-emoji="${e}" aria-label="${e}">${e}</button>`).join('')}`).join('')}</div></div>`;
  }
  async function togglePanel(name) {
    chat.panel = chat.panel === name ? null : name;
    if (chat.panel === 'stickers' && !chat.stickers) {
      renderExtra();
      try { chat.stickers = (await P.api('stickers.packs')).packs; } catch (error) { P.failed(error); chat.stickers = []; }
    }
    renderExtra();
  }
  function rememberEmoji(emoji) {
    const recent = JSON.parse(P.readPref('pingup.recent_emoji', '[]') || '[]').filter(e => e !== emoji);
    recent.unshift(emoji);
    P.storePref('pingup.recent_emoji', JSON.stringify(recent.slice(0, 24)));
  }
  function insertEmoji(emoji) {
    const input = $('#message-input', chat.screen);
    if (!input) return;
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + emoji.length;
    rememberEmoji(emoji);
    onInput();
    if (!PU.isMobile()) input.focus();
  }
  function onInput() {
    autoResize();
    updateSendMode();
    const input = $('#message-input', chat.screen);
    if (!input || !state.active) return;
    state.drafts.set(Number(state.active), { text: input.value });
    sendTyping(!!input.value, 'typing');
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftNow, 1200);
  }
  function saveDraftNow() {
    clearTimeout(draftTimer);
    const id = Number(state.active), draft = state.drafts.get(id), conv = P.findConversation(id);
    if (!id || !draft || !conv || (conv.draft || '') === draft.text) return;
    conv.draft = draft.text;
    P.post('conversations.draft', { conversation_id: id, text: draft.text }).catch(() => {});
  }
  function sendTyping(active, kind) {
    const id = state.active;
    if (!id) return;
    if (active && Date.now() - typingSent > 3000) { typingSent = Date.now(); P.post('typing.set', { conversation_id: id, typing: true, kind }).catch(() => {}); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { typingSent = 0; P.post('typing.set', { conversation_id: id, typing: false }).catch(() => {}); }, active ? 4000 : 0);
  }
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  async function submit() {
    if (chat.recorder) { stopRecording(false); return; }
    if (!hasContent()) { startRecording(); return; }
    if (chat.edit) return saveEdit();
    const pending = chat.attachments.filter(a => a.status !== 'done');
    if (pending.some(a => a.status === 'uploading')) { P.toast(t('chat.wait_uploads')); return; }
    if (pending.some(a => a.status === 'error')) { P.toast(t('chat.remove_failed_uploads'), 'error'); return; }
    const input = $('#message-input', chat.screen);
    const text = input.value.trim();
    const files = chat.attachments.map(a => ({ ...a.result, voice: false }));
    const reply = chat.reply;
    input.value = '';
    state.drafts.set(Number(state.active), { text: '' });
    chat.attachments = [];
    chat.reply = null;
    renderTray();
    renderExtra();
    autoResize();
    updateSendMode();
    sendTyping(false);
    const media = files.filter(f => ['image', 'video'].includes(f.kind));
    if (files.length > 1 && media.length === files.length) await send({ text, files, reply });
    else if (files.length) {
      for (let i = 0; i < files.length; i++) await send({ text: i === files.length - 1 ? text : '', file: files[i], reply: i === 0 ? reply : null });
    } else await send({ text, reply });
    const conv = P.currentConversation();
    if (conv) conv.draft = '';
  }
  async function send({ text = '', file = null, files = null, reply = null, sticker = null, poll = null, retry = null, sendAt = null }) {
    const id = Number(retry?.conversation_id || state.active);
    if (!id) return;
    const clientId = retry?.client_id || uid();
    if (sendAt) {
      try {
        await P.post('messages.send', { conversation_id: id, text, client_id: clientId, reply_to: reply?.id, file_id: file?.id, file_ids: files?.map(f => f.id), send_at: sendAt });
        P.toast(t('chat.scheduled_ok', { time: new Date(sendAt * 1000).toLocaleString(state.locale, { dateStyle: 'medium', timeStyle: 'short' }) }), 'success');
      } catch (error) { P.failed(error); }
      return;
    }
    const message = retry || {
      id: `pending-${clientId}`, conversation_id: id, sender_id: state.user.id, text,
      kind: poll ? 'poll' : sticker ? 'sticker' : files ? 'album' : file?.voice ? 'voice' : file ? 'file' : 'text',
      file: files ? null : file, files: files || [], sticker, poll: poll ? { question: poll.question, options: poll.options.map((o, i) => ({ id: -i, text: o, votes: 0 })), total_voters: 0, multiple: poll.multiple, anonymous: poll.anonymous } : null,
      reply_to: reply?.id || null, reply: reply ? { id: reply.id, sender_id: reply.sender_id, sender_name: sender(reply).name, text: reply.text, kind: reply.kind } : null,
      created_at: Math.floor(Date.now() / 1000), client_id: clientId, reactions: [], payload: { file_id: file?.id, file_ids: files?.map(f => f.id), sticker_id: sticker?.id, poll, kind: file?.voice ? 'voice' : undefined },
    };
    message.pending = true;
    message.failed = false;
    if (!state.messages.has(id)) state.messages.set(id, new Map());
    state.messages.get(id).set(message.id, message);
    if (Number(state.active) === id) { insertMessage(message, { animate: !retry }); relayout(); scrollBottom(true); }
    try {
      await window.PingUpExperience?.queue(message);
      const saved = await P.post('messages.send', { conversation_id: id, text: message.text, client_id: clientId, reply_to: message.reply_to || undefined, ...message.payload });
      await window.PingUpExperience?.ack(clientId);
      const map = state.messages.get(id);
      map.delete(message.id);
      map.set(saved.id, saved);
      window.PingUpExperience?.sound('send');
      if (Number(state.active) === id) { insertMessage(saved, { animate: false }); relayout(); }
      const conv = P.findConversation(id);
      if (conv) { conv.last_message = saved; conv.updated_at = saved.created_at; conv.last_read_message_id = Math.max(conv.last_read_message_id, saved.id); state.conversations.sort((a, b) => (b.pinned - a.pinned) || (b.updated_at - a.updated_at)); P.updateConversationList(); }
    } catch (error) {
      message.pending = false;
      message.failed = true;
      message.retryable = ['network', 'storage_busy'].includes(error.code);
      state.messages.get(id)?.set(message.id, message);
      if (Number(state.active) === id) insertMessage(message, { animate: false });
      P.failed(error);
    }
  }
  async function saveEdit() {
    const input = $('#message-input', chat.screen), m = chat.edit, text = input.value.trim();
    if (!m) return;
    const previous = { ...m };
    chat.edit = null;
    input.value = state.drafts.get(Number(state.active))?.stashed || '';
    renderExtra(); autoResize(); updateSendMode();
    if (text === m.text) return;
    Object.assign(m, { text, edited: true });
    insertMessage(m, { animate: false });
    try { upsert([await P.post('messages.edit', { message_id: m.id, text })], { animate: false }); }
    catch (error) { Object.assign(m, previous); insertMessage(m, { animate: false }); P.failed(error); }
  }

  /* ---------- Attachments ---------- */
  function addFiles(fileList) {
    if (!state.active || !chat.conv?.permissions?.post) return;
    const files = [...fileList];
    if (chat.attachments.length + files.length > 10) { P.toast(t('chat.too_many_files'), 'error'); files.length = Math.max(0, 10 - chat.attachments.length); }
    const extensions = state.config.upload_extensions || [];
    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (extensions.length && !extensions.includes(ext)) { P.toast(t('error.file_type_forbidden') + ': ' + file.name, 'error'); continue; }
      if (file.size > Number(state.config.max_upload_bytes)) { P.premiumNudge(!state.premium?.active && file.size <= Number(state.config.premium_upload_bytes) ? 'file_too_large_premium' : 'file_too_large'); continue; }
      const item = { key: uid(), file, status: 'uploading', progress: 0, controller: new AbortController(), preview: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null };
      chat.attachments.push(item);
      startUpload(item);
    }
    renderTray();
    updateSendMode();
  }
  async function startUpload(item) {
    item.status = 'uploading';
    item.progress = 0;
    item.controller = new AbortController();
    renderTray();
    sendTyping(true, 'uploading');
    try {
      item.result = await P.uploadFile(item.file, 'file', { signal: item.controller.signal, onProgress: p => { item.progress = p; updateProgress(item); } });
      item.status = 'done';
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'aborted') return;
      item.status = 'error';
      item.error = error;
      P.failed(error);
    }
    renderTray();
    updateSendMode();
  }
  function ring(p) { const c = 2 * Math.PI * 18; return `<svg class="ring" viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="18"/><circle class="value" cx="22" cy="22" r="18" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}"/></svg>`; }
  function updateProgress(item) {
    const el = $(`[data-attach="${item.key}"] .attach-progress`, chat.screen);
    if (el) el.innerHTML = ring(item.progress) + `<span style="position:absolute">${Math.round(item.progress * 100)}%</span>`;
  }
  function renderTray() {
    const tray = $('.attach-tray', chat.screen);
    if (!tray) return;
    tray.hidden = !chat.attachments.length;
    tray.innerHTML = chat.attachments.map(item => {
      const kind = item.file.type.startsWith('image/') ? 'image' : item.file.type.startsWith('video/') ? 'video' : item.file.type.startsWith('audio/') ? 'music' : 'file';
      const thumb = item.preview ? (kind === 'video' ? `<video src="${item.preview}" muted></video>` : `<img src="${item.preview}" alt="">`) : icon(kind);
      return `<div class="attach-item ${item.status}" data-attach="${item.key}"><button type="button" class="attach-remove" data-remove-attach="${item.key}" aria-label="${esc(t('chat.remove_attachment'))}">${icon('close')}</button><div class="attach-thumb">${thumb}${item.status === 'uploading' ? `<span class="attach-progress">${ring(item.progress)}<span style="position:absolute">${Math.round(item.progress * 100)}%</span></span>` : ''}${item.status === 'error' ? `<button type="button" class="attach-retry" data-retry-attach="${item.key}" aria-label="${esc(t('common.retry'))}">${icon('refresh')}</button>` : ''}</div><small>${esc(item.file.name)}</small><small>${esc(P.fileSize(item.file.size))}</small></div>`;
    }).join('');
  }
  function removeAttachment(key) {
    const item = chat.attachments.find(a => a.key === key);
    if (!item) return;
    item.controller?.abort();
    if (item.preview) URL.revokeObjectURL(item.preview);
    chat.attachments = chat.attachments.filter(a => a !== item);
    renderTray();
    updateSendMode();
  }
  function attachMenu(anchor) {
    const conv = chat.conv;
    PU.menu([
      { icon: 'image', label: t('chat.attach_media'), action: () => pickFiles('image/*,video/*') },
      { icon: 'file', label: t('chat.attach_file'), action: () => pickFiles('') },
      { icon: 'music', label: t('chat.attach_audio'), action: () => pickFiles('audio/*') },
      conv.type !== 'direct' && conv.type !== 'saved' ? { icon: 'poll', label: t('chat.create_poll'), action: createPoll } : null,
      { icon: 'sticker', label: t('chat.stickers'), action: () => togglePanel('stickers') },
      { icon: 'calendar', label: t('chat.scheduled_list'), action: showScheduled },
    ], PU.isMobile() ? { title: t('chat.attachment') } : { anchor });
  }
  function pickFiles(accept) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => addFiles(input.files);
    input.click();
  }

  /* ---------- Voice messages ---------- */
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { P.toast(t('chat.record_unavailable'), 'error'); return; }
    const id = state.active;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (state.active !== id) { stream.getTracks().forEach(track => track.stop()); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined), chunks = [];
      chat.recorder = recorder;
      chat.recordStream = stream;
      chat.recordStart = Date.now();
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', async () => {
        stream.getTracks().forEach(track => track.stop());
        const discarded = recorder.discarded;
        chat.recorder = null;
        renderRecording(false);
        if (discarded || !chunks.length || Date.now() - chat.recordStart < 600) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
        try {
          const file = await P.uploadFile(new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type }), 'voice');
          if (state.active === id) await send({ file: { ...file, voice: true } });
        } catch (error) { P.failed(error); }
      });
      recorder.start();
      renderRecording(true);
      sendTyping(true, 'recording');
      chat.recordTimer = setInterval(() => {
        const s = Math.floor((Date.now() - chat.recordStart) / 1000);
        const label = $('.record-status span', chat.screen);
        if (label) label.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (s % 3 === 0) sendTyping(true, 'recording');
        if (s >= 300) stopRecording(false);
      }, 500);
    } catch { P.toast(t('chat.microphone_denied'), 'error'); }
  }
  function stopRecording(discard) {
    clearInterval(chat.recordTimer);
    if (chat.recorder && chat.recorder.state !== 'inactive') { chat.recorder.discarded = discard; chat.recorder.stop(); }
    chat.recordStream?.getTracks().forEach(track => track.stop());
    if (discard) { chat.recorder = null; renderRecording(false); }
    sendTyping(false);
  }
  function renderRecording(on) {
    const field = $('.composer-field', chat.screen), button = $('.send-btn', chat.screen);
    if (!field || !button) return;
    field.hidden = on;
    $('.record-status', chat.screen)?.remove();
    if (on) field.insertAdjacentHTML('afterend', `<div class="record-status"><i></i><span>0:00</span><button type="button" class="text-btn" data-action="cancel-record">${esc(t('common.cancel'))}</button></div>`);
    button.classList.toggle('recording', on);
    button.dataset.mode = on ? 'stop' : '';
    button.innerHTML = icon(on ? 'send' : 'mic');
    if (!on) updateSendMode();
  }

  /* ---------- Context menu ---------- */
  const findMessage = id => msgs().get(Number(id)) || msgs().get(id);
  function canDeleteForEveryone(m) {
    const conv = chat.conv;
    if (isOwn(m) || ['direct', 'saved'].includes(conv?.type)) return true;
    if (m.thread_root_id && conv?.permissions?.moderate_comments) return true;
    return !!conv?.permissions?.delete_others;
  }
  function messageMenu(id, point) {
    const m = findMessage(id);
    if (!m || m.pending) return;
    if (chat.selecting) { toggleSelect(m.id); return; }
    const conv = chat.conv;
    const quick = (state.settings.favorite_reactions?.length ? state.settings.favorite_reactions : QUICK_DEFAULT).slice(0, 6);
    const allowed = conv.type === 'channel' && conv.settings?.allowed_reactions?.length ? conv.settings.allowed_reactions : null;
    const reactionsOn = !(conv.type === 'channel' && conv.settings?.reactions_enabled === false) && !m.call && !m.deleted;
    const header = reactionsOn ? `<div class="quick-reactions">${(allowed || quick).map(e => `<button data-quick-react="${e}" class="${m.reactions?.some(r => r.emoji === e && r.mine) ? 'mine' : ''}">${e}</button>`).join('')}${allowed ? '' : `<button class="more-reactions" data-more-reactions aria-label="${esc(t('chat.more_reactions'))}">${icon('plus')}</button>`}</div>` : '';
    const own = isOwn(m), text = m.text && !m.deleted;
    const items = m.deleted ? [{ icon: 'trash', label: t('delete.self'), danger: true, action: () => deleteMessages([m], 'self') }] : [
      !m.call && conv.permissions?.post !== false || m.thread_root_id ? { id: 'reply', icon: 'reply', label: t('chat.reply'), action: () => setReply(m) } : null,
      own && text && !['poll', 'sticker'].includes(m.kind) && !m.call ? { id: 'edit', icon: 'edit', label: t('common.edit'), action: () => startEdit(m) } : null,
      text ? { id: 'copy', icon: 'copy', label: t('common.copy'), action: () => copyText(m.text) } : null,
      !m.call && m.kind !== 'poll' ? { id: 'forward', icon: 'forward', label: t('chat.forward'), action: () => forward([m]) } : null,
      conv.permissions?.pin && !m.call ? { id: 'pin', icon: 'pin', label: t(m.pinned ? 'chat.unpin' : 'chat.pin'), action: () => pin(m) } : null,
      { id: 'star', icon: 'star', label: t(m.starred ? 'chat.unstar' : 'chat.star'), action: () => star(m) },
      m.kind === 'sticker' && m.sticker ? { icon: 'sticker', label: t('stickers.add_pack'), action: () => installPack(m) } : null,
      conv.type !== 'saved' && !m.call ? { id: 'save', icon: 'saved', label: t('chat.save'), action: () => saveToSaved(m) } : null,
      (conv.type === 'group' || (conv.type === 'channel' && conv.permissions?.view_stats)) && m.reactions?.length ? { icon: 'users', label: t('chat.reactions_who'), action: () => reactors(m) } : null,
      m.kind === 'poll' && (own || conv.permissions?.delete_others) && !m.poll?.closed ? { icon: 'lock', label: t('poll.close'), action: () => closePoll(m) } : null,
      { id: 'select', icon: 'select', label: t('chat.select'), action: () => enterSelection(m.id) },
      { separator: true },
      { id: 'delete', icon: 'trash', label: t('delete.title'), danger: true, action: () => confirmDelete([m]) },
    ];
    const preview = `<div class="menu-preview">${esc(P.messagePreview(m)).slice(0, 200)}</div>`;
    const handle = PU.menu(items, point && !PU.isMobile() ? { x: point.x, y: point.y, header } : { header: header + preview });
    handle.el.addEventListener('click', async event => {
      const quickButton = event.target.closest('[data-quick-react]');
      if (quickButton) { handle.close(); react(m.id, quickButton.dataset.quickReact); }
      if (event.target.closest('[data-more-reactions]')) { handle.close(); reactionPicker(m); }
    });
  }
  function reactionPicker(m) {
    const all = Object.values(EMOJI).flat();
    const s = PU.sheet({ title: t('chat.react'), body: `<div class="emoji-grid">${all.map(e => `<button data-pick="${e}">${e}</button>`).join('')}</div>` });
    s.el.addEventListener('click', event => { const b = event.target.closest('[data-pick]'); if (b) { s.close(); react(m.id, b.dataset.pick); } });
  }
  async function copyText(text) { try { await navigator.clipboard.writeText(text); P.toast(t('common.copied'), 'success'); } catch { P.toast(t('common.error'), 'error'); } }
  function setReply(m) { chat.reply = m; chat.edit = null; renderExtra(); $('#message-input', chat.screen)?.focus(); }
  function startEdit(m) {
    const input = $('#message-input', chat.screen);
    if (!input) return;
    state.drafts.set(Number(state.active), { text: input.value, stashed: input.value });
    chat.edit = m;
    chat.reply = null;
    input.value = m.text;
    renderExtra(); autoResize(); updateSendMode();
    input.focus();
  }
  async function react(id, emoji) {
    const m = findMessage(id);
    if (!m) return;
    const before = JSON.parse(JSON.stringify(m.reactions || []));
    // Optimistic toggle; the server result (or a rollback) replaces it.
    const existing = m.reactions.find(r => r.emoji === emoji);
    if (existing?.mine) { existing.count--; existing.mine = false; if (existing.count <= 0) m.reactions = m.reactions.filter(r => r !== existing); }
    else if (existing) { existing.count++; existing.mine = true; }
    else m.reactions = [...(m.reactions || []), { emoji, count: 1, mine: true }];
    insertMessage(m, { animate: false });
    PU.vibrate(6);
    try { upsert([await P.post('messages.react', { message_id: Number(id), emoji })], { animate: false }); }
    catch (error) { m.reactions = before; insertMessage(m, { animate: false }); P.failed(error); }
  }
  async function pin(m) {
    const value = !m.pinned;
    m.pinned = value;
    insertMessage(m, { animate: false });
    updatePins();
    try { upsert([await P.post('messages.pin', { message_id: m.id, pinned: value })], { animate: false }); P.toast(t(value ? 'chat.pinned' : 'chat.unpinned'), 'success'); if (!value) chat.pins = (chat.pins || []).filter(p => p.id !== m.id); }
    catch (error) { m.pinned = !value; insertMessage(m, { animate: false }); updatePins(); P.failed(error); }
  }
  async function star(m) {
    const value = !m.starred;
    m.starred = value;
    insertMessage(m, { animate: false });
    try { await P.post('messages.star', { message_id: m.id, starred: value }); P.toast(t(value ? 'chat.starred' : 'chat.unstarred'), 'success'); }
    catch (error) { m.starred = !value; insertMessage(m, { animate: false }); P.failed(error); }
  }
  async function saveToSaved(m) { try { await P.post('messages.save', { message_id: m.id }); P.toast(t('chat.saved_to_saved'), 'success'); } catch (error) { P.failed(error); } }
  async function installPack(m) { try { await P.post('stickers.install', { message_id: m.id }); chat.stickers = null; P.toast(t('stickers.added'), 'success'); } catch (error) { P.failed(error); } }
  async function closePoll(m) { try { upsert([await P.post('polls.close', { message_id: m.id })], { animate: false }); } catch (error) { P.failed(error); } }
  async function reactors(m) {
    const s = PU.sheet({ title: t('chat.reactions_who'), body: '<div class="spinner"></div>' });
    try {
      const data = await P.api('messages.reactors', { message_id: m.id });
      s.body.innerHTML = `<div class="list">${data.reactors.map(r => `<button class="list-item" data-profile="${r.user.id}">${P.avatar(r.user, 'sm')}<span class="li-body"><strong>${esc(r.user.name)}${P.badges(r.user)}</strong><small>@${esc(r.user.username)}</small></span><span style="font-size:22px">${esc(r.emoji)}</span></button>`).join('') || `<p class="muted">${esc(t('common.empty'))}</p>`}</div>`;
    } catch (error) { s.body.innerHTML = `<p class="form-error">${esc(P.errText(error))}</p>`; }
  }
  async function confirmDelete(list) {
    const everyone = list.every(canDeleteForEveryone) && chat.conv.type !== 'saved';
    const items = [{ id: 'delete-self', icon: 'trash', label: t('delete.self'), hint: t('delete.self_hint'), danger: true, action: () => deleteMessages(list, 'self') }];
    if (everyone) items.unshift({ id: 'delete-everyone', icon: 'trash', label: t('delete.everyone'), hint: t(chat.conv.type === 'direct' ? 'delete.everyone_hint' : 'delete.everyone_hint_group'), danger: true, action: () => deleteMessages(list, 'everyone') });
    PU.menu(items, { title: list.length > 1 ? t('delete.title_many', { count: list.length }) : t('delete.title') });
  }
  async function deleteMessages(list, scope) {
    const els = list.map(m => elFor(m)).filter(Boolean);
    els.forEach(el => el.classList.add('leaving'));
    try {
      const ids = list.map(m => m.id).filter(Number.isFinite);
      const result = ids.length === 1 ? { messages: [await P.post('messages.delete', { message_id: ids[0], scope })] } : await P.post('messages.delete_many', { message_ids: ids, scope });
      for (const m of result.messages) {
        const map = msgs();
        if (m.hidden || m.deleted) { map.set(m.id, m); const el = elFor(m); if (el) removeEl(el); }
      }
      exitSelection();
      P.toast(t('delete.done'), 'success');
    } catch (error) {
      els.forEach(el => el.classList.remove('leaving'));
      P.failed(error);
    }
  }
  function forward(list) {
    const conversations = state.conversations.filter(c => c.permissions?.post !== false && !c.community_archived);
    const s = PU.sheet({ title: t('chat.forward_to'), body: `<label class="searchbar" style="margin:0 0 8px">${icon('search')}<input data-forward-search placeholder="${esc(t('chat.search'))}"></label><div class="list" data-forward-list>${conversations.map(c => `<button class="list-item" data-forward-to="${c.id}">${P.convAvatar(c, 'sm')}<span class="li-body"><strong>${esc(P.convName(c))}</strong></span></button>`).join('')}</div>`, full: PU.isMobile() });
    s.el.addEventListener('input', event => {
      if (!event.target.matches('[data-forward-search]')) return;
      const q = event.target.value.toLocaleLowerCase();
      $$('[data-forward-to]', s.el).forEach(b => { b.hidden = !b.textContent.toLocaleLowerCase().includes(q); });
    });
    s.el.addEventListener('click', async event => {
      const b = event.target.closest('[data-forward-to]');
      if (!b) return;
      s.close();
      try {
        await P.post('messages.forward_many', { message_ids: list.map(m => m.id), conversation_id: Number(b.dataset.forwardTo), client_id: 'fwd:' + uid() });
        exitSelection();
        P.toast(t('chat.forwarded_ok'), 'success', { action: t('chat.open'), onAction: () => open(Number(b.dataset.forwardTo)) });
        P.poll();
      } catch (error) { P.failed(error); }
    });
  }

  /* ---------- Selection mode ---------- */
  function enterSelection(firstId) {
    chat.selecting = true;
    chat.selected = new Set([String(firstId)]);
    chat.screen.classList.add('selecting');
    renderSelection();
  }
  function exitSelection() {
    chat.selecting = false;
    chat.selected = new Set();
    if (!chat.screen) return;
    chat.screen.classList.remove('selecting');
    $$('.msg.selected', chat.screen).forEach(el => el.classList.remove('selected'));
    $('.select-bar', chat.screen)?.remove();
  }
  function toggleSelect(id) {
    const key = String(id);
    if (chat.selected.has(key)) chat.selected.delete(key); else chat.selected.add(key);
    if (!chat.selected.size) { exitSelection(); return; }
    renderSelection();
  }
  function renderSelection() {
    $$('.msg', chat.screen).forEach(el => el.classList.toggle('selected', chat.selected.has(el.dataset.messageId)));
    let bar = $('.select-bar', chat.screen);
    if (!bar) { $('.chat-head', chat.screen).insertAdjacentHTML('beforeend', '<div class="select-bar"></div>'); bar = $('.select-bar', chat.screen); }
    bar.innerHTML = `<button class="icon-btn" data-action="exit-select" aria-label="${esc(t('common.cancel'))}">${icon('close')}</button><strong>${esc(t('chat.selected_count', { count: chat.selected.size }))}</strong><button class="icon-btn" data-action="bulk-copy" aria-label="${esc(t('common.copy'))}">${icon('copy')}</button><button class="icon-btn" data-action="bulk-forward" aria-label="${esc(t('chat.forward'))}">${icon('forward')}</button><button class="icon-btn" data-action="bulk-star" aria-label="${esc(t('chat.star'))}">${icon('star')}</button><button class="icon-btn" data-action="bulk-delete" aria-label="${esc(t('delete.title'))}">${icon('trash')}</button>`;
  }
  const selectedMessages = () => [...chat.selected].map(findMessage).filter(m => m && !m.pending).sort((a, b) => a.id - b.id);

  /* ---------- Polls ---------- */
  function createPoll() {
    const s = PU.sheet({
      title: t('chat.create_poll'),
      body: `<form class="form" id="poll-form"><label class="field"><span>${esc(t('poll.question'))}</span><input name="question" required maxlength="300"></label><div class="field"><span>${esc(t('poll.options'))}</span><div class="poll-options">${[0, 1].map(i => `<input name="option" required maxlength="100" placeholder="${esc(t('poll.option_n', { n: i + 1 }))}">`).join('')}</div><button type="button" class="text-btn" data-add-option>${icon('plus')} ${esc(t('poll.add_option'))}</button></div><label class="option-row"><span class="li-body">${esc(t('poll.anonymous'))}</span><span class="switch"><input type="checkbox" name="anonymous" checked><i></i></span></label><label class="option-row"><span class="li-body">${esc(t('poll.multiple'))}</span><span class="switch"><input type="checkbox" name="multiple"><i></i></span></label><button class="btn primary block" type="submit">${esc(t('poll.create'))}</button></form>`,
    });
    s.el.addEventListener('click', event => {
      if (!event.target.closest('[data-add-option]')) return;
      const box = $('.poll-options', s.el);
      if (box.children.length >= 10) return;
      box.insertAdjacentHTML('beforeend', `<input name="option" maxlength="100" placeholder="${esc(t('poll.option_n', { n: box.children.length + 1 }))}">`);
      box.lastElementChild.focus();
    });
    s.el.addEventListener('submit', event => {
      event.preventDefault();
      const form = new FormData(event.target);
      const options = form.getAll('option').map(o => o.trim()).filter(Boolean);
      if (options.length < 2) { P.toast(t('poll.need_two'), 'error'); return; }
      s.close();
      send({ poll: { question: form.get('question').trim(), options, anonymous: form.get('anonymous') === 'on', multiple: form.get('multiple') === 'on' } });
    });
  }
  async function vote(m, optionIds) {
    try { upsert([await P.post('polls.vote', { message_id: m.id, option_ids: optionIds })], { animate: false }); }
    catch (error) { P.failed(error); }
  }
  async function pollVoters(m) {
    const s = PU.sheet({ title: t('poll.show_voters'), body: '<div class="spinner"></div>' });
    try {
      const data = await P.api('polls.voters', { message_id: m.id });
      s.body.innerHTML = m.poll.options.map(o => `<div class="group-title">${esc(o.text)} · ${o.votes}</div><div class="list">${data.voters.filter(v => v.option_id === o.id).map(v => `<button class="list-item" data-profile="${v.user.id}">${P.avatar(v.user, 'sm')}<span class="li-body"><strong>${esc(v.user.name)}</strong></span></button>`).join('')}</div>`).join('');
    } catch (error) { s.body.innerHTML = `<p class="form-error">${esc(P.errText(error))}</p>`; }
  }

  /* ---------- Scheduling ---------- */
  function scheduleSheet() {
    if (!hasContent() || chat.edit) { showScheduled(); return; }
    const pad = n => String(n).padStart(2, '0'), soon = new Date(Date.now() + 3600000);
    const local = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
    const s = PU.sheet({ title: t('chat.schedule'), body: `<form class="form" id="schedule-form"><label class="field"><span>${esc(t('chat.schedule_time'))}</span><input type="datetime-local" name="at" required value="${local}"></label><button class="btn primary block" type="submit">${icon('calendar')}${esc(t('chat.schedule_send'))}</button></form>` });
    s.el.addEventListener('submit', async event => {
      event.preventDefault();
      const at = Math.floor(new Date(new FormData(event.target).get('at')).getTime() / 1000);
      if (!at || at < Date.now() / 1000 + 30) { P.toast(t('error.invalid_schedule'), 'error'); return; }
      if (chat.attachments.some(a => a.status !== 'done')) { P.toast(t('chat.wait_uploads')); return; }
      s.close();
      const input = $('#message-input', chat.screen), files = chat.attachments.map(a => a.result);
      const payload = { text: input.value.trim(), reply: chat.reply, sendAt: at };
      if (files.length > 1) payload.files = files; else if (files.length) payload.file = files[0];
      input.value = ''; chat.attachments = []; chat.reply = null;
      renderTray(); renderExtra(); autoResize(); updateSendMode();
      await send(payload);
    });
  }
  async function showScheduled() {
    const id = state.active;
    const s = PU.sheet({ title: t('chat.scheduled_list'), body: '<div class="spinner"></div>' });
    const load = async () => {
      try {
        const data = await P.api('messages.scheduled', { conversation_id: id });
        s.body.innerHTML = data.scheduled.length ? `<div class="list">${data.scheduled.map(m => `<div class="list-item"><span class="li-icon ic-blue">${icon('calendar')}</span><span class="li-body"><strong>${esc(m.text || t(m.has_file ? 'chat.file' : 'chat.message'))}</strong><small>${esc(new Date(m.send_at * 1000).toLocaleString(state.locale, { dateStyle: 'medium', timeStyle: 'short' }))}${m.status === 'failed' ? ' · ' + esc(P.errText({ code: m.error })) : ''}</small></span><span class="li-actions"><button class="icon-btn" data-sched-now="${m.id}" aria-label="${esc(t('chat.send_now'))}">${icon('send')}</button><button class="icon-btn" data-sched-cancel="${m.id}" aria-label="${esc(t('common.cancel'))}">${icon('trash')}</button></span></div>`).join('')}</div>` : P.empty('calendar', t('chat.scheduled_empty'), t('chat.scheduled_hint'));
      } catch (error) { s.body.innerHTML = `<p class="form-error">${esc(P.errText(error))}</p>`; }
    };
    s.el.addEventListener('click', async event => {
      const now = event.target.closest('[data-sched-now]'), cancel = event.target.closest('[data-sched-cancel]');
      try {
        if (now) { await P.post('messages.scheduled_now', { id: Number(now.dataset.schedNow) }); P.poll(); }
        if (cancel) await P.post('messages.scheduled_cancel', { id: Number(cancel.dataset.schedCancel) });
        if (now || cancel) load();
      } catch (error) { P.failed(error); }
    });
    load();
  }

  /* ---------- Header menu ---------- */
  function chatMenu(anchor) {
    const conv = chat.conv;
    if (!conv) return;
    const peerUser = P.peer(conv), direct = conv.type === 'direct';
    const modes = direct ? ['all', 'none'] : ['all', 'mentions', 'none'];
    PU.menu([
      direct && PU.isMobile() ? { icon: 'phone', label: t('chat.call'), action: () => window.PingUpCalls?.start(peerUser, 'audio') } : null,
      direct && PU.isMobile() ? { icon: 'video', label: t('calls.video'), action: () => window.PingUpCalls?.start(peerUser, 'video') } : null,
      { icon: 'search', label: t('chat.search_messages'), action: () => window.PingUpPages?.search('', { conversationId: conv.id }) },
      { icon: 'image', label: t('chat.shared_media'), action: () => window.PingUpPages?.search('', { conversationId: conv.id, type: 'media' }) },
      { icon: 'info', label: t(direct ? 'profile.view' : conv.type === 'channel' ? 'channel.info' : 'group.info'), action: chatInfo },
      ...modes.map(mode => ({ icon: mode === 'none' ? 'bellOff' : 'bell', label: t(`notify.mode_${mode}`), active: conv.notification_mode === mode, action: () => setMode(mode) })),
      { icon: 'pin', label: t(conv.pinned ? 'chat.unpin_chat' : 'chat.pin_chat'), action: () => togglePinChat(conv) },
      { icon: 'archive', label: t(conv.archived ? 'chat.unarchive' : 'chat.archive_chat'), action: () => toggleArchive(conv) },
      conv.type === 'channel' && conv.role !== 'owner' ? { icon: 'palette', label: t(conv.own_theme ? 'channel.use_channel_theme' : 'channel.use_own_theme'), action: () => toggleOwnTheme(conv) } : null,
      conv.permissions?.post ? { icon: 'calendar', label: t('chat.scheduled_list'), action: showScheduled } : null,
      { icon: 'select', label: t('chat.select'), action: () => { const last = [...$$('.msg', chat.screen)].pop(); if (last) enterSelection(last.dataset.messageId); } },
      { separator: true },
      { icon: 'bug', label: t('feedback.report_problem'), action: () => window.PingUpPages?.feedbackForm('bug', 'messages') },
      direct && Number(peerUser?.id) !== Number(state.user.id) ? { icon: 'block', label: t('contacts.block'), danger: true, action: () => window.PingUpPages?.block(peerUser) } : null,
      conv.type !== 'direct' && conv.type !== 'saved' && conv.role !== 'owner' ? { icon: 'logout', label: t(conv.type === 'channel' ? 'channel.leave' : 'group.leave'), danger: true, action: () => window.PingUpPages?.leaveCommunity(conv) } : null,
    ], PU.isMobile() ? {} : { anchor });
  }
  async function setMode(mode) {
    const conv = chat.conv;
    const previous = conv.notification_mode;
    conv.notification_mode = mode;
    P.updateConversationList();
    if (!conv.permissions?.post) { $('.composer-wrap', chat.screen)?.replaceWith(Object.assign(document.createElement('div'), { innerHTML: composerHTML(conv) }).firstElementChild); }
    try { await P.post('notifications.chat', { conversation_id: conv.id, mode }); P.toast(t(`notify.mode_${mode}`), 'success'); }
    catch (error) { conv.notification_mode = previous; P.updateConversationList(); P.failed(error); }
  }
  async function togglePinChat(conv) {
    try { P.retainConversation(await P.post('conversations.pin', { conversation_id: conv.id, pinned: !conv.pinned })); P.poll(); }
    catch (error) { P.failed(error); }
  }
  async function toggleArchive(conv) {
    const value = !conv.archived;
    conv.archived = value;
    P.updateConversationList();
    try {
      await P.post('conversations.archive', { conversation_id: conv.id, archived: value });
      P.toast(t(value ? 'chat.archived' : 'chat.unarchived'), 'success', value ? { action: t('common.undo'), onAction: () => toggleArchive(P.findConversation(conv.id)) } : {});
      if (value && Number(state.active) === Number(conv.id)) close();
    } catch (error) { conv.archived = !value; P.updateConversationList(); P.failed(error); }
  }
  async function toggleOwnTheme(conv) {
    try { const fresh = await P.post('channels.own_theme', { conversation_id: conv.id, enabled: !conv.own_theme }); Object.assign(conv, fresh); applyChannelSkin(conv); }
    catch (error) { P.failed(error); }
  }
  function chatInfo() {
    const conv = chat.conv;
    if (!conv) return;
    if (conv.type === 'direct') return P.openProfile(P.peer(conv).id);
    if (conv.type === 'saved') return;
    window.PingUpPages?.communityInfo(conv.id);
  }

  /* ---------- Screen bindings ---------- */
  function bindScreen(screen) {
    const a = $('.messages', screen);
    a.addEventListener('scroll', () => {
      updateJump();
      if (a.scrollTop < 300 && chat.hasMore) loadOlder();
    }, { passive: true });
    PU.swipeAction(a, '.msg:not(.pending):not(.failed):not(.call-log)', {
      enabled: () => !chat.selecting && (chat.conv?.permissions?.post || false),
      onSwipe: el => { const m = findMessage(el.dataset.messageId); if (m && !m.deleted) setReply(m); },
    });
    PU.longPress(a, '.msg', (el, point) => {
      if (chat.selecting) { toggleSelect(el.dataset.messageId); return; }
      messageMenu(el.dataset.messageId, point);
    });
    // Drag & drop and clipboard images.
    let dragDepth = 0;
    screen.addEventListener('dragenter', event => { if (![...event.dataTransfer.types].includes('Files') || !chat.conv?.permissions?.post) return; dragDepth++; if (!$('.drop-overlay', screen)) screen.insertAdjacentHTML('beforeend', `<div class="drop-overlay">${esc(t('chat.drop_files'))}</div>`); });
    screen.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('.drop-overlay', screen)?.remove(); } });
    screen.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
    screen.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('.drop-overlay', screen)?.remove(); if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files); });
    screen.addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files); } });
    const send = $('.send-btn', screen);
    if (send) {
      send.addEventListener('contextmenu', event => { event.preventDefault(); scheduleSheet(); });
      let holdTimer;
      send.addEventListener('touchstart', () => { holdTimer = setTimeout(() => { if (hasContent()) { PU.vibrate(12); scheduleSheet(); holdTimer = 'fired'; } }, 550); }, { passive: true });
      send.addEventListener('touchend', event => { if (holdTimer === 'fired') event.preventDefault(); clearTimeout(holdTimer); holdTimer = null; });
    }
  }
  function mediaItemsInChat() {
    const items = [];
    for (const m of [...msgs().values()].sort((a, b) => a.id - b.id)) {
      if (m.deleted || m.hidden) continue;
      for (const f of m.kind === 'album' ? m.files : m.file ? [m.file] : []) if (['image', 'video'].includes(f.kind)) items.push({ id: f.id, url: f.url, kind: f.kind, name: f.name });
    }
    return items;
  }

  document.addEventListener('click', event => {
    if (!chat.screen || !chat.screen.contains(event.target) && !event.target.closest('.pu-sheet-root,.pu-popover-root')) return;
    const el = event.target.closest('button,a,[data-jump-pin]');
    const msgEl = event.target.closest('.msg');
    if (chat.selecting && msgEl && chat.screen.contains(msgEl) && !event.target.closest('.select-bar')) { event.preventDefault(); toggleSelect(msgEl.dataset.messageId); return; }
    if (!el) return;
    const d = el.dataset;
    if (d.jumpPin && el.classList.contains('pins')) { jumpTo(d.jumpPin); chat.pinIndex = (chat.pinIndex + 1) % Math.max(1, chat.pinList?.length || 1); setTimeout(updatePins, 300); return; }
    if (d.jumpMessage) { jumpTo(d.jumpMessage); return; }
    if (d.messageMenu) { const r = el.getBoundingClientRect(); messageMenu(d.messageMenu, { x: r.right, y: r.bottom }); return; }
    if (d.reply && !el.closest('.pu-sheet-root')) { const m = findMessage(d.reply); if (m) setReply(m); return; }
    if (d.react && d.message) { react(d.message, d.react); return; }
    if (d.retryMessage) { const m = [...msgs().values()].find(x => x.client_id === d.retryMessage); if (m) send({ retry: m }); return; }
    if (d.viewMedia) { const items = mediaItemsInChat(); PU.viewer(items, Math.max(0, items.findIndex(i => String(i.id) === d.viewMedia)), $('img,video', el)); return; }
    if (d.pdfPreview) { PU.sheet({ title: t('media.preview'), wide: true, body: `<iframe class="pdf-frame" src="${esc(d.url)}&preview=1" title="PDF"></iframe>` }); return; }
    if (d.redial) { const user = chat.conv?.participants?.find(u => Number(u.id) === Number(d.redial)); if (user) window.PingUpCalls?.start(user, d.callKind || 'audio'); return; }
    if (d.pollOption) {
      const m = findMessage(d.message);
      if (!m?.poll || m.poll.closed) return;
      if (m.poll.multiple) { el.classList.toggle('selected'); return; }
      vote(m, m.poll.options.find(o => o.mine)?.id === Number(d.pollOption) ? [] : [Number(d.pollOption)]);
      return;
    }
    if (d.pollSubmit) { const m = findMessage(d.pollSubmit), box = el.closest('.poll'); vote(m, $$('.poll-option.selected', box).map(b => Number(b.dataset.pollOption))); return; }
    if (d.pollVoters) { pollVoters(findMessage(d.pollVoters)); return; }
    if (d.openThread) { window.PingUpThread?.open(findMessage(d.openThread), chat.conv); return; }
    if (d.hashtag) { window.PingUpPages?.search('#' + d.hashtag, { conversationId: state.active }); return; }
    if (d.mention) { window.PingUpPages?.search('@' + d.mention, { type: 'people' }); return; }
    if (d.insertEmoji) { insertEmoji(d.insertEmoji); return; }
    if (d.panel) { togglePanel(d.panel); return; }
    if (d.sendSticker) { const pack = (chat.stickers || []).flatMap(p => p.stickers).find(s => String(s.id) === d.sendSticker); if (pack) { send({ sticker: pack }); chat.panel = null; renderExtra(); } return; }
    if (d.removeAttach) { removeAttachment(d.removeAttach); return; }
    if (d.retryAttach) { const item = chat.attachments.find(a => a.key === d.retryAttach); if (item) startUpload(item); return; }
    switch (d.action) {
      case 'chat-back': close(); break;
      case 'chat-info': chatInfo(); break;
      case 'chat-menu': chatMenu(el); break;
      case 'chat-search': window.PingUpPages?.search('', { conversationId: state.active }); break;
      case 'call': case 'video-call': { const user = P.peer(chat.conv); if (window.PingUpCalls && user?.id !== state.user.id) window.PingUpCalls.start(user, d.action === 'call' ? 'audio' : 'video'); break; }
      case 'older': loadOlder(); break;
      case 'jump-down': chat.newCount = 0; scrollBottom(true); break;
      case 'emoji-panel': togglePanel('emoji'); break;
      case 'attach-menu': attachMenu(el); break;
      case 'clear-reply': chat.reply = null; renderExtra(); break;
      case 'cancel-edit': { const input = $('#message-input', chat.screen); chat.edit = null; input.value = state.drafts.get(Number(state.active))?.stashed || ''; renderExtra(); autoResize(); updateSendMode(); break; }
      case 'cancel-record': stopRecording(true); break;
      case 'toggle-mute': setMode(chat.conv.notification_mode === 'none' ? 'all' : 'none'); break;
      case 'reload-chat': { const id = state.active; closeScreen(); open(id); break; }
      case 'exit-select': exitSelection(); break;
      case 'bulk-forward': forward(selectedMessages()); break;
      case 'bulk-delete': confirmDelete(selectedMessages()); break;
      case 'bulk-copy': copyText(selectedMessages().filter(m => m.text).map(m => m.text).join('\n\n')); exitSelection(); break;
      case 'bulk-star': Promise.all(selectedMessages().map(m => P.post('messages.star', { message_id: m.id, starred: true }).then(() => { m.starred = true; insertMessage(m, { animate: false }); }))).then(() => P.toast(t('chat.starred'), 'success')).catch(P.failed); exitSelection(); break;
    }
  });
  document.addEventListener('submit', event => { if (event.target.id === 'message-form' && chat.screen?.contains(event.target)) { event.preventDefault(); submit(); } });
  document.addEventListener('input', event => { if (event.target.id === 'message-input' && chat.screen?.contains(event.target)) onInput(); });
  document.addEventListener('keydown', event => {
    if (event.target.id !== 'message-input' || !chat.screen) return;
    const enterSends = state.settings.enter_to_send !== false && !PU.isMobile();
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && enterSends) { event.preventDefault(); submit(); }
    if (event.key === 'Escape' && (chat.reply || chat.edit)) { chat.reply = null; chat.edit = null; renderExtra(); }
    if (event.key === 'ArrowUp' && !event.target.value) {
      const last = [...msgs().values()].filter(m => isOwn(m) && m.text && !m.deleted && !m.pending && !m.call && !['poll', 'sticker'].includes(m.kind)).sort((a, b) => b.id - a.id)[0];
      if (last) { event.preventDefault(); startEdit(last); }
    }
  });

  /* ---------- Sync integration ---------- */
  function applySync(data) {
    const conv = P.findConversation(state.active);
    if (conv) chat.conv = conv;
    upsert(data.messages || [], { animate: true });
    upsert(data.updated_messages || [], { animate: false });
    if (data.change_cursor !== undefined) state.changeCursors.set(Number(state.active), Number(data.change_cursor));
    refreshTicks();
    const status = $('.chat-status', chat.screen);
    if (status && conv) {
      state.typing.set(Number(conv.id), data.typing || []);
      const html = headerStatus(conv);
      if (status.innerHTML !== html) status.innerHTML = html;
      status.classList.toggle('live', !!data.typing?.length);
    }
    if (data.messages?.some(m => !isOwn(m))) window.PingUpExperience?.sound('message');
    scheduleRead();
  }
  function refreshTicks() {
    if (!chat.screen || !chat.conv) return;
    for (const el of $$('.msg.own', chat.screen)) {
      const m = findMessage(el.dataset.messageId);
      const ticks = $('.ticks', el);
      if (!m || !ticks) continue;
      const status = deliveryStatus(m, chat.conv);
      if (ticks.dataset.status === status) continue;
      const tpl = document.createElement('template');
      tpl.innerHTML = ticksHTML(m, chat.conv);
      const fresh = tpl.content.firstElementChild;
      fresh.classList.add('bump');
      ticks.replaceWith(fresh);
    }
  }
  function maxMessageId(id) {
    return Math.max(0, ...[...msgs(id).values()].filter(m => !m.pending && !m.failed && !m.thread_root_id).map(m => Number(m.id)).filter(Number.isFinite));
  }
  function restoreQueued(message) {
    const id = Number(message.conversation_id);
    Object.assign(message, { pending: false, failed: true, retryable: true });
    if (!state.messages.has(id)) state.messages.set(id, new Map());
    state.messages.get(id).set(message.id, message);
    if (Number(state.active) === id) insertMessage(message, { animate: false });
  }
  function retryFailed() {
    if (!state.user) return;
    for (const map of state.messages.values()) for (const message of map.values()) if (message.failed && message.retryable) send({ retry: message });
  }
  P.on('conversations', () => {
    if (!chat.screen || !state.active) return;
    const conv = P.findConversation(state.active);
    if (!conv) return;
    const permissionsChanged = JSON.stringify(conv.permissions) !== JSON.stringify(chat.conv?.permissions) || conv.community_archived !== chat.conv?.community_archived;
    chat.conv = conv;
    if (permissionsChanged) { stash(); const wrap = $('.composer-wrap', chat.screen); if (wrap) { wrap.outerHTML = composerHTML(conv); bindScreen(chat.screen); } }
    applyChannelSkin(conv);
    refreshTicks();
  });
  P.on('leave-page', page => { if (page === 'chats' && state.active) closeScreen(); });
  P.on('visible', () => { scheduleRead(); });

  window.PingUpChat = {
    open, close, reset: () => { closeScreen(); }, applySync, maxMessageId, restoreQueued, retryFailed, deliveryStatus,
    rerender: () => { if (state.active) { const id = state.active; closeScreen(); open(id); } },
    jumpTo, send, insertMessage, upsert, messageHTML, bubbleInner, findMessage, react, isOwn,
  };
})();
