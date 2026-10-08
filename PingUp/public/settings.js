'use strict';
/* PingUp settings: profile, privacy, notifications, appearance, Premium, e-mail & security, folders,
   starred messages, language, help & feedback centre and administration. */
(() => {
  const { $, $$, esc, icon } = PU;
  const P = window.PingUp, state = P.state, t = P.t;
  const Pages = window.PingUpPages = window.PingUpPages || {};
  const loading = '<div class="spinner"></div>';
  const errorBlock = error => `<p class="form-error pad">${esc(P.errText(error))}</p>`;
  const FREE_THEMES = ['pingup', 'ocean', 'sunset', 'forest', 'graphite'];
  const PREMIUM_THEMES = ['aurora', 'midnight_glass', 'neon_pulse', 'purple_galaxy', 'cyber_blue', 'emerald', 'golden_night', 'liquid_gradient'];
  const FREE_WALLPAPERS = ['none', 'dots', 'waves', 'grid', 'soft'];
  const PREMIUM_WALLPAPERS = ['stardust', 'aurora_flow', 'neon_grid', 'liquid'];
  const FREE_ACCENTS = ['#a78bfa', '#60a5fa', '#f472b6', '#34d399', '#f59e0b', '#ef4444', '#22d3ee', '#94a3b8'];
  const PREMIUM_ACCENTS = ['#e879f9', '#fbbf24', '#2dd4bf', '#fb7185', '#818cf8', '#a3e635'];
  const THEME_SAMPLES = { pingup: ['#8a79ff', '#59c9ee'], ocean: ['#3d8bff', '#4ce0d2'], sunset: ['#ff6f91', '#ffc75f'], forest: ['#2a9d8f', '#b5e48c'], graphite: ['#6b7280', '#cbd5e1'], aurora: ['#3ef0b5', '#b26bff'], midnight_glass: ['#5b6cff', '#e0e7ff'], neon_pulse: ['#ff3df2', '#00f0ff'], purple_galaxy: ['#5b2bd8', '#ff8ae2'], cyber_blue: ['#0066ff', '#00ffd0'], emerald: ['#047857', '#a7f3d0'], golden_night: ['#b8860b', '#fff1c1'], liquid_gradient: ['#ff8fb1', '#8fffcf'] };
  const isPremium = () => !!state.premium?.active;
  const save = patch => window.PingUpExperience.save(patch);
  const row = (iconName, color, label, { hint = '', value = '', attrs = '', badge = '' } = {}) => `<button class="list-item" ${attrs}><span class="li-icon ic-${color}">${icon(iconName)}</span><span class="li-body"><strong>${esc(label)}${badge}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</span>${value ? `<span class="li-value">${esc(value)}</span>` : ''}${icon('chevron')}</button>`;
  const toggle = (name, label, checked, hint = '', attr = 'data-setting') => `<label class="option-row"><span class="li-body"><strong>${esc(label)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</span><span class="switch"><input type="checkbox" ${attr}="${name}" ${checked ? 'checked' : ''}><i></i></span></label>`;
  function banner(id, title, text) {
    if (isPremium() || (state.settings.dismissed_banners || []).includes(id)) return '';
    return `<div class="premium-banner" data-banner="${id}"><span class="li-icon">${icon('crown')}</span><div><strong>${esc(title)}</strong><small>${esc(text)}</small></div><button class="btn small premium" data-open-section="premium">${esc(t('premium.learn'))}</button><button class="icon-btn" data-dismiss-banner="${id}" aria-label="${esc(t('common.close'))}">${icon('close')}</button></div>`;
  }

  /* ---------- Settings tab ---------- */
  P.registerPage('settings', {
    render(el) {
      const u = state.user;
      el.innerHTML = `<header class="app-bar"><h1>${esc(t('nav.settings'))}</h1><button class="icon-btn" data-action="search" aria-label="${esc(t('search.title'))}">${icon('search')}</button></header><div class="scroller"><div class="page-content page-inner settings-layout"><button class="list-item" data-open-section="profile" style="margin:4px 12px 14px;width:calc(100% - 24px);padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">${P.avatar(u, 'lg')}<span class="li-body"><strong>${esc(u.name)}${P.badges(u)}</strong><small>@${esc(u.username)}${u.email && u.email_verified ? ' · ' + esc(u.email) : ''}</small></span>${icon('chevron')}</button>${banner('settings', t('premium.banner_title'), t('premium.banner_text'))}<div class="group-card list">${row('profile', 'violet', t('settings.profile'), { attrs: 'data-open-section="profile"' })}${row('lock', 'blue', t('settings.privacy'), { hint: t('privacy.row_hint'), attrs: 'data-open-section="privacy"' })}${row('mail', 'teal', t('settings.security'), { hint: u.email ? (u.email_verified ? t('email.verified_short') : t('email.pending_short')) : t('email.not_set_short'), attrs: 'data-open-section="security"' })}</div><div class="group-card list">${row('bell', 'red', t('settings.notifications'), { attrs: 'data-open-section="notifications"' })}${row('palette', 'pink', t('settings.appearance'), { attrs: 'data-open-section="appearance"' })}${row('folder', 'orange', t('folders.title'), { value: String(state.folders.length || ''), attrs: 'data-open-section="folders"' })}${row('globe', 'green', t('settings.language'), { value: { uk: 'Українська', ru: 'Русский', en: 'English' }[state.locale], attrs: 'data-open-section="language"' })}</div><div class="group-card list">${row('crown', 'premium', 'PingUp Premium', { hint: isPremium() ? (state.premium.forever ? t('premium.forever') : t('premium.until', { date: P.longDate(state.premium.ends_at) })) : t('premium.short_pitch'), attrs: 'data-open-section="premium"' })}${row('saved', 'blue', t('nav.saved'), { attrs: 'data-open-saved' })}${row('star', 'orange', t('starred.title'), { attrs: 'data-open-section="starred"' })}${row('sticker', 'pink', t('stickers.title'), { attrs: 'data-open-section="stickers"' })}</div><div class="group-card list">${row('help', 'green', t('feedback.title'), { hint: t('feedback.subtitle'), attrs: 'data-open-section="feedback"', badge: state.feedbackUnread ? ` <b class="badge">${state.feedbackUnread}</b>` : '' })}${row('bug', 'red', t('feedback.report_problem'), { attrs: 'data-feedback-new="bug"' })}${u.role === 'admin' ? row('shield', 'gray', t('admin.title'), { attrs: 'data-open-section="admin"', badge: state.admin?.feedback_unread ? ` <b class="badge">${state.admin.feedback_unread}</b>` : '' }) : ''}</div><div class="group-card list">${row('info', 'gray', t('settings.about'), { value: `PingUp ${P.VERSION}`, attrs: 'data-open-section="about"' })}<button class="list-item" data-action="logout" style="color:var(--danger)"><span class="li-icon ic-red">${icon('logout')}</span><span class="li-body"><strong>${esc(t('settings.logout'))}</strong></span></button></div></div></div>`;
    },
  });
  Pages.openSection = name => {
    const handlers = { stickers: stickersPage, profile: profilePage, privacy: privacyPage, notifications: notificationsPage, appearance: appearancePage, premium: premiumPage, security: securityPage, folders: foldersPage, starred: starredPage, language: languagePage, feedback: feedbackHub, admin: adminPage, about: aboutPage, blocked: () => { P.setPage('contacts'); setTimeout(() => $('[data-contacts-tab="blocked"]')?.click(), 50); } };
    handlers[name]?.();
  };

  /* ---------- Profile ---------- */
  function profilePage() {
    const u = state.user;
    const page = Pages.subpage(t('settings.profile'));
    page.body.innerHTML = `<form class="form pad" id="profile-form"><div class="profile-hero"><button type="button" data-change-avatar aria-label="${esc(t('profile.change_avatar'))}">${P.avatar(u, 'xxl')}</button><div style="display:flex;gap:8px"><button type="button" class="btn small" data-change-avatar>${icon('camera')}${esc(t('profile.change_avatar'))}</button>${u.avatar_url ? `<button type="button" class="btn small ghost" data-remove-avatar>${esc(t('profile.remove_avatar'))}</button>` : ''}</div></div><label class="field"><span>${esc(t('profile.name'))}</span><input name="name" maxlength="60" required value="${esc(u.name)}" autocomplete="name"></label><label class="field"><span>${esc(t('profile.username'))}</span><div class="input-prefix"><i>@</i><input name="username" minlength="3" maxlength="24" pattern="[A-Za-z][A-Za-z0-9_]{2,23}" required value="${esc(u.username)}" autocomplete="username"></div><small>${esc(t('profile.username_hint'))}</small></label><label class="field"><span>${esc(t('profile.bio'))}</span><textarea name="bio" rows="3" maxlength="300" placeholder="${esc(t('profile.bio_hint'))}">${esc(u.bio || '')}</textarea></label><label class="field"><span>${esc(t('profile.location'))}</span><input name="location" maxlength="80" value="${esc(u.location || '')}"></label><label class="field"><span>${esc(t('profile.website'))}</span><input name="website" type="url" maxlength="200" value="${esc(u.website || '')}" placeholder="https://"></label><div class="field"><span>${esc(t('profile.effect'))} <span class="premium-badge">${icon('crown')}</span></span><div class="chips" style="padding:0">${['none', 'glow', 'sparkle', 'aurora', 'neon'].map(e => `<button type="button" class="chip ${(u.profile_effect_choice || 'none') === e ? 'active' : ''}" data-effect="${e}">${esc(t(`effect.${e}`))}</button>`).join('')}</div>${isPremium() ? '' : `<small>${esc(t('premium.feature_locked'))}</small>`}</div><div class="form-error" hidden></div><button class="btn primary block" type="submit">${icon('check')}${esc(t('profile.save'))}</button></form>`;
    page.el.addEventListener('click', async event => {
      if (event.target.closest('[data-change-avatar]')) {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif' });
        input.onchange = async () => {
          if (!input.files[0]) return;
          try { const file = await P.uploadFile(input.files[0], 'avatar'); state.user = await P.post('profile.update', { avatar_file_id: file.id }); page.close(); profilePage(); P.toast(t('profile.updated'), 'success'); }
          catch (error) { P.failed(error); }
        };
        input.click();
      }
      if (event.target.closest('[data-remove-avatar]')) { try { state.user = await P.post('profile.update', { avatar_file_id: null }); page.close(); profilePage(); } catch (error) { P.failed(error); } }
      const effect = event.target.closest('[data-effect]');
      if (effect) {
        if (!isPremium() && effect.dataset.effect !== 'none') { P.premiumNudge('premium_required'); return; }
        try { state.user = await P.post('profile.update', { profile_effect: effect.dataset.effect }); $$('[data-effect]', page.el).forEach(b => b.classList.toggle('active', b === effect)); }
        catch (error) { P.failed(error); }
      }
    });
    page.el.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, button = $('[type=submit]', form);
      button.classList.add('loading');
      try { state.user = await P.post('profile.update', Object.fromEntries(new FormData(form))); P.toast(t('profile.updated'), 'success'); page.close(); P.renderShell(); }
      catch (error) { const e = $('.form-error', form); e.hidden = false; e.textContent = P.errText(error); }
      finally { button.classList.remove('loading'); }
    });
  }

  /* ---------- Privacy ---------- */
  const PRIVACY_ITEMS = [['last_seen', 'clock'], ['online', 'eye'], ['avatar', 'camera'], ['bio', 'info'], ['profile', 'profile'], ['message_first', 'chats'], ['calls', 'phone'], ['group_invites', 'users'], ['contact_requests', 'userPlus'], ['read_receipts', 'checks'], ['typing', 'text']];
  function privacyPage() {
    const page = Pages.subpage(t('settings.privacy'));
    const render = () => {
      const p = state.privacy;
      page.body.innerHTML = `<p class="hint">${esc(t('privacy.intro'))}</p><div class="group-card list">${PRIVACY_ITEMS.map(([key, ic]) => row(ic, 'blue', t(`privacy.${key}`), { value: t(`privacy.value_${p[key] || 'everyone'}`), attrs: `data-privacy="${key}"` })).join('')}</div><div class="group-card">${toggle('searchable', t('privacy.searchable'), p.searchable !== false, t('privacy.searchable_hint'), 'data-privacy-toggle')}</div><div class="group-card list">${row('block', 'red', t('contacts.blocked'), { attrs: 'data-open-section="blocked"' })}</div><p class="hint">${esc(t('privacy.server_note'))}</p>`;
    };
    render();
    const apply = async patch => {
      const previous = { ...state.privacy };
      Object.assign(state.privacy, patch);
      render();
      try { state.privacy = await P.post('privacy.update', patch); render(); P.toast(t('privacy.saved'), 'success'); }
      catch (error) { state.privacy = previous; render(); P.failed(error); }
    };
    page.el.addEventListener('click', event => {
      const b = event.target.closest('[data-privacy]');
      if (!b) return;
      const key = b.dataset.privacy, current = state.privacy[key] || 'everyone';
      const options = key === 'contact_requests' ? ['everyone', 'contacts', 'nobody'] : ['everyone', 'contacts', 'nobody'];
      PU.menu(options.map(v => ({ icon: v === 'everyone' ? 'globe' : v === 'contacts' ? 'users' : 'lock', label: t(`privacy.value_${v}`), hint: key === 'contact_requests' && v === 'contacts' ? t('privacy.contacts_shared') : '', active: current === v, action: () => apply({ [key]: v }) })), { title: t(`privacy.${key}`), header: `<p class="hint" style="padding:0 6px 10px">${esc(t(`privacy.${key}_hint`))}</p>` });
    });
    page.el.addEventListener('change', event => { if (event.target.dataset.privacyToggle) apply({ searchable: event.target.checked }); });
  }

  /* ---------- Notifications ---------- */
  function notificationsPage() {
    const page = Pages.subpage(t('settings.notifications'));
    const render = () => {
      const s = state.settings;
      page.body.innerHTML = `<div class="group-card">${toggle('dnd', t('settings.quiet'), s.dnd, t('settings.quiet_hint'))}${toggle('preview', t('notify.preview'), s.preview, t('notify.preview_hint'))}</div><div class="group-title">${esc(t('notify.sounds'))}</div><div class="group-card">${toggle('sounds', t('notify.sounds'), s.sounds)}${toggle('message_sound', t('notify.message_sound'), s.message_sound)}${toggle('send_sound', t('notify.send_sound'), s.send_sound)}${toggle('call_sound', t('notify.call_sound'), s.call_sound)}<label class="option-row"><span class="li-body"><strong>${esc(t('notify.volume'))}</strong></span><input type="range" min="0" max="100" value="${Math.round((s.volume ?? 0.35) * 100)}" data-volume style="max-width:160px"></label></div><div class="group-title">${esc(t('notify.system'))}</div><div class="group-card list"><button class="list-item" data-push-toggle><span class="li-icon ic-red">${icon('bell')}</span><span class="li-body"><strong>${esc(t(s.system ? 'notify.disable' : 'notify.enable'))}</strong><small>${esc(t('notify.autoplay_hint'))}</small></span></button></div><div class="group-title">${esc(t('settings.chats'))}</div><div class="group-card">${toggle('enter_to_send', t('settings.enter_to_send'), s.enter_to_send !== false, t('settings.enter_to_send_hint'))}<div class="option-row"><span class="li-body"><strong>${esc(t('reactions.quick'))}</strong><small>${esc(t('reactions.quick_hint'))}</small></span></div><div class="quick-reactions" style="margin:0 10px 10px">${(s.favorite_reactions || []).map(e => `<button data-remove-favorite="${e}" aria-label="${esc(t('common.remove'))} ${e}">${e}</button>`).join('')}${(s.favorite_reactions || []).length < 8 ? `<button class="more-reactions" data-add-favorite aria-label="${esc(t('common.add'))}">${icon('plus')}</button>` : ''}</div></div>`;
    };
    render();
    page.el.addEventListener('change', async event => {
      const key = event.target.dataset.setting;
      if (key) { try { await save({ [key]: event.target.checked }); } catch (error) { event.target.checked = !event.target.checked; P.failed(error); } }
      if (event.target.hasAttribute('data-volume')) save({ volume: Number(event.target.value) / 100 }).catch(P.failed);
    });
    page.el.addEventListener('click', event => {
      const favorites = state.settings.favorite_reactions || [];
      const remove = event.target.closest('[data-remove-favorite]');
      if (remove) save({ favorite_reactions: favorites.filter(e => e !== remove.dataset.removeFavorite) }).then(render).catch(P.failed);
      if (event.target.closest('[data-add-favorite]')) {
        const picker = PU.sheet({ title: t('reactions.quick'), body: `<div class="emoji-grid">${'❤️ 👍 🔥 😂 🥹 ✨ 😮 😢 🎉 🙏 👏 💯 🤔 😍 🤝 👀 💜 🙌 😎 🤯 😡 👌 🫶 ⚡'.split(' ').map(e => `<button data-pick-favorite="${e}">${e}</button>`).join('')}</div>` });
        picker.el.addEventListener('click', e => { const b = e.target.closest('[data-pick-favorite]'); if (b) { picker.close(); save({ favorite_reactions: [...new Set([...favorites, b.dataset.pickFavorite])].slice(0, 8) }).then(render).catch(P.failed); } });
      }
    });
    P.on('settings', () => { if (!page.closed && !page.el.contains(document.activeElement)) render(); });
  }

  /* ---------- Appearance ---------- */
  function appearancePage() {
    const page = Pages.subpage(t('settings.appearance'));
    const render = () => {
      const s = state.settings, eff = s.effective || s;
      const themeCard = (name, premium) => { const [a, b] = THEME_SAMPLES[name]; const locked = premium && !isPremium(); return `<button class="theme-card ${eff.theme_name === name ? 'active' : ''}" data-theme-name="${name}" data-premium="${premium ? 1 : 0}"><span class="preview" style="background:linear-gradient(135deg, ${a}, ${b})"><i></i><i class="own"></i></span><span>${esc(t(`skin.${name}`))}${premium ? `<span class="premium-badge">${icon('crown')}</span>` : ''}</span>${locked ? `<span class="lock">${icon('lock')}</span>` : ''}</button>`; };
      page.body.innerHTML = `${banner('appearance', t('premium.banner_themes'), t('premium.banner_themes_text'))}<div class="preview-chat"><div class="msg"><div class="msg-col"><div class="bubble"><div class="msg-text">${esc(t('appearance.preview_in'))}<span class="msg-meta"><time>${esc(P.shortTime(Date.now() / 1000 - 120))}</time></span></div></div></div></div><div class="msg own"><div class="msg-col"><div class="bubble"><div class="msg-text">${esc(t('appearance.preview_out'))}<span class="msg-meta"><time>${esc(P.shortTime(Date.now() / 1000))}</time><span class="ticks read">${icon('checks')}</span></span></div></div><div class="msg-reactions"><span class="reaction mine">💜<span>1</span></span></div></div></div></div><div class="group-title">${esc(t('settings.theme_mode'))}</div><div class="pad"><div class="segmented">${['dark', 'light', 'system'].map(m => `<button class="${state.theme === m ? 'active' : ''}" data-theme-choice="${m}">${icon(m === 'dark' ? 'moon' : m === 'light' ? 'sun' : 'settings')} ${esc(t(`settings.${m}`))}</button>`).join('')}</div></div><div class="group-title">${esc(t('appearance.themes'))}</div><div class="pad"><div class="theme-grid">${FREE_THEMES.map(n => themeCard(n, false)).join('')}</div></div><div class="group-title">${esc(t('appearance.premium_themes'))}</div><div class="pad"><div class="theme-grid">${PREMIUM_THEMES.map(n => themeCard(n, true)).join('')}</div></div><div class="group-title">${esc(t('appearance.accent'))}</div><div class="swatches">${[...FREE_ACCENTS.map(c => [c, false]), ...PREMIUM_ACCENTS.map(c => [c, true])].map(([c, prem]) => `<button class="swatch ${eff.accent === c ? 'active' : ''}" style="background:${c}" data-accent="${c}" data-premium="${prem ? 1 : 0}" aria-label="${c}">${prem && !isPremium() ? `<span class="lock">${icon('lock')}</span>` : ''}</button>`).join('')}</div><div class="group-title">${esc(t('appearance.wallpaper'))}</div><div class="pad"><div class="theme-grid">${[...FREE_WALLPAPERS.map(w => [w, false]), ...PREMIUM_WALLPAPERS.map(w => [w, true])].map(([w, prem]) => `<button class="theme-card ${eff.wallpaper === w ? 'active' : ''}" data-wallpaper="${w}" data-premium="${prem ? 1 : 0}"><span class="preview" data-wallpaper-sample="${w}" style="background:var(--bg)"><i></i><i class="own"></i></span><span>${esc(t(`wallpaper.${w}`))}${prem ? `<span class="premium-badge">${icon('crown')}</span>` : ''}</span>${prem && !isPremium() ? `<span class="lock">${icon('lock')}</span>` : ''}</button>`).join('')}</div></div><div class="group-title">${esc(t('appearance.text'))}</div><div class="group-card"><label class="option-row"><span class="li-body"><strong>${esc(t('appearance.font_size'))}</strong><small>${s.font_size || 15}px</small></span><input type="range" min="13" max="20" value="${s.font_size || 15}" data-font-size style="max-width:180px"></label></div><div class="group-title">${esc(t('appearance.scale'))}</div><div class="chips">${[['compact', '90%'], ['standard', '100%'], ['comfortable', '110%'], ['large', '125%']].map(([v, p]) => `<button class="chip ${s.scale === v ? 'active' : ''}" data-ui-scale="${v}">${esc(t(`appearance.${v}`))} · ${p}</button>`).join('')}</div>${[['density', ['compact', 'comfortable']], ['list_density', ['compact', 'default', 'spacious']], ['radius', ['sharp', 'default', 'round']], ['bubble_style', ['modern', 'classic', 'minimal']], ['time_format', ['auto', '24', '12']]].map(([key, values]) => `<div class="group-title">${esc(t(`appearance.${key}`))}</div><div class="chips">${values.map(v => `<button class="chip ${s[key] === v ? 'active' : ''}" data-enum="${key}" data-value="${v}">${esc(t(`appearance.${key}_${v}`))}</button>`).join('')}</div>`).join('')}<div class="group-title">${esc(t('motion.title'))}</div><div class="group-card">${toggle('motion', t('motion.enabled'), s.motion !== false, t('motion.hint'))}</div>`;
      $$('[data-wallpaper-sample]', page.el).forEach(el => { el.parentElement.style.setProperty('--wallpaper', ''); el.setAttribute('data-wallpaper', el.dataset.wallpaperSample); el.style.background = 'var(--wallpaper), var(--surface-2)'; });
    };
    render();
    const apply = async patch => {
      try { await save(patch); render(); }
      catch (error) { P.failed(error); }
    };
    page.el.addEventListener('click', event => {
      const theme = event.target.closest('[data-theme-name]'), accent = event.target.closest('[data-accent]'), wall = event.target.closest('[data-wallpaper]:not([data-wallpaper-sample])'), choice = event.target.closest('[data-theme-choice]'), en = event.target.closest('[data-enum]'), scale = event.target.closest('[data-ui-scale]');
      const locked = el => el.dataset.premium === '1' && !isPremium();
      if (theme) { if (locked(theme)) { previewPremium(theme.dataset.themeName); return; } apply({ theme_name: theme.dataset.themeName }); }
      if (accent) { if (locked(accent)) { P.premiumNudge('premium_required'); return; } apply({ accent: accent.dataset.accent }); }
      if (wall) { if (locked(wall)) { P.premiumNudge('premium_required'); return; } apply({ wallpaper: wall.dataset.wallpaper }); }
      if (choice) { P.changeTheme(choice.dataset.themeChoice); render(); }
      if (en) apply({ [en.dataset.enum]: en.dataset.value });
      if (scale) apply({ scale: scale.dataset.uiScale });
    });
    page.el.addEventListener('change', event => {
      if (event.target.dataset.setting === 'motion') apply({ motion: event.target.checked });
      if (event.target.hasAttribute('data-font-size')) apply({ font_size: Number(event.target.value) });
    });
    page.el.addEventListener('input', event => { if (event.target.hasAttribute('data-font-size')) document.documentElement.style.setProperty('--font-size', `${event.target.value}px`); });
  }
  /* A locked premium theme can be previewed for a few seconds without being saved. */
  function previewPremium(name) {
    const root = document.documentElement, previous = root.dataset.skin;
    root.dataset.skin = name;
    P.toast(t('premium.preview_theme', { name: t(`skin.${name}`) }), 'info', { action: t('premium.learn'), onAction: () => { root.dataset.skin = previous; Pages.openSection('premium'); }, duration: 5000 });
    setTimeout(() => { if (root.dataset.skin === name) root.dataset.skin = previous; }, 5000);
  }

  /* ---------- Premium ---------- */
  async function premiumPage() {
    const page = Pages.subpage('PingUp Premium');
    page.body.innerHTML = loading;
    try {
      const info = await P.api('premium.status');
      state.premium = { ...state.premium, ...info };
      const active = info.active;
      const status = active ? (info.forever ? t('premium.forever') : t('premium.until', { date: P.longDate(info.ends_at) })) : info.expired ? t('premium.expired') : t('premium.not_active');
      const features = [['crown', 'premium.f_badge'], ['palette', 'premium.f_themes'], ['image', 'premium.f_wallpapers'], ['sparkles', 'premium.f_effects'], ['download', 'premium.f_upload'], ['star', 'premium.f_colors']];
      page.body.innerHTML = `<div class="premium-hero"><span class="crown">${icon('crown')}</span><h2>PingUp Premium</h2><p>${esc(t('premium.tagline'))}</p><span class="status-pill">${esc(status)}</span></div><div class="group-card list">${features.map(([ic, k]) => `<div class="list-item"><span class="li-icon ic-premium">${icon(ic)}</span><span class="li-body"><strong>${esc(t(k))}</strong><small>${esc(t(k + '_hint'))}</small></span></div>`).join('')}</div><div class="group-title">${esc(t('premium.compare'))}</div><div class="group-card pad"><table class="compare"><thead><tr><th></th><th>Free</th><th>Premium</th></tr></thead><tbody>${[['premium.c_upload', '50 MB', '200 MB'], ['premium.c_themes', '5', '13'], ['premium.c_accents', '8', '14'], ['premium.c_wallpapers', '5', '9'], ['premium.c_badge', false, true], ['premium.c_effects', false, true]].map(([k, a, b]) => `<tr><td>${esc(t(k))}</td><td class="${a === false ? 'no' : ''}">${a === false ? icon('close') : esc(a)}</td><td>${b === true ? icon('check') : esc(b)}</td></tr>`).join('')}</tbody></table></div><div class="group-title">${esc(t('appearance.premium_themes'))}</div><div class="pad"><div class="theme-grid">${PREMIUM_THEMES.map(n => { const [a, b] = THEME_SAMPLES[n]; return `<button class="theme-card" data-preview-theme="${n}"><span class="preview" style="background:linear-gradient(135deg, ${a}, ${b})"><i></i><i class="own"></i></span><span>${esc(t(`skin.${n}`))}</span></button>`; }).join('')}</div></div><div class="group-title">${esc(t('premium.manage'))}</div><div class="group-card pad" style="padding:14px"><p>${esc(t(active ? 'premium.manage_active' : 'premium.payments_soon'))}</p>${info.history?.length ? `<div class="list" style="margin-top:10px">${info.history.map(h => `<div class="list-item"><span class="li-icon ${h.state === 'active' ? 'ic-premium' : 'ic-gray'}">${icon('crown')}</span><span class="li-body"><strong>${esc(t(`premium.state_${h.state}`))} · ${esc(t(`premium.source_${h.source}`))}</strong><small>${esc(P.longDate(h.starts_at))} — ${h.ends_at ? esc(P.longDate(h.ends_at)) : esc(t('premium.no_end'))}</small></span></div>`).join('')}</div>` : ''}<button class="btn block" style="margin-top:12px" data-feedback-new="question" data-feedback-category="premium">${icon('help')}${esc(t('premium.ask'))}</button></div>`;
      page.el.addEventListener('click', event => { const b = event.target.closest('[data-preview-theme]'); if (b) { if (isPremium()) save({ theme_name: b.dataset.previewTheme }).then(() => P.toast(t('appearance.applied'), 'success')).catch(P.failed); else previewPremium(b.dataset.previewTheme); } });
    } catch (error) { page.body.innerHTML = errorBlock(error); }
  }

  /* ---------- E-mail & security ---------- */
  function securityPage() {
    const page = Pages.subpage(t('settings.security'));
    let status = null, timer = null;
    const render = () => {
      const s = status;
      const emailBlock = !s ? loading : `<div class="group-card list"><div class="list-item"><span class="li-icon ic-teal">${icon('mail')}</span><span class="li-body"><strong>${esc(s.email || t('email.not_set'))}</strong><small>${esc(s.email ? (s.verified ? t('email.verified') : t('email.not_verified')) : t('email.why'))}</small></span></div></div>${s.pending_email ? `<form class="form pad" data-email-verify><p class="hint" style="padding:0">${esc(t('email.code_sent', { email: s.pending_email }))}</p><label class="field"><span>${esc(t('email.code'))}</span><input name="code" class="code-input" inputmode="numeric" maxlength="6" pattern="\\d{6}" autocomplete="one-time-code" required></label><div style="display:flex;gap:8px"><button class="btn primary" type="submit" style="flex:1">${esc(t('email.verify'))}</button><button class="btn" type="button" data-email-resend ${s.resend_after > 0 ? 'disabled' : ''}>${esc(s.resend_after > 0 ? t('email.resend_in', { seconds: s.resend_after }) : t('email.resend'))}</button></div></form>` : ''}<form class="form pad" data-email-set><label class="field"><span>${esc(t(s.email ? 'email.change' : 'email.add'))}</span><input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="name@example.com"></label><label class="field"><span>${esc(t('auth.current_password'))}</span><input name="password" type="password" required autocomplete="current-password"></label><button class="btn primary" type="submit">${esc(t('email.send_code'))}</button></form>${s.email ? `<div class="pad"><button class="btn danger block" data-email-unlink>${esc(t('email.unlink'))}</button></div>` : ''}${!s.delivery_configured ? `<p class="hint">${esc(t('email.delivery_not_configured'))}</p>` : ''}`;
      page.body.innerHTML = `<div class="group-title">${esc(t('email.title'))}</div>${emailBlock}<div class="group-title">${esc(t('settings.password_title'))}</div><form class="form pad" id="password-form"><label class="field"><span>${esc(t('auth.current_password'))}</span><input name="current_password" type="password" required autocomplete="current-password"></label><label class="field"><span>${esc(t('auth.new_password'))}</span><input name="new_password" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></label><label class="field"><span>${esc(t('auth.confirm_new_password'))}</span><input name="confirm_password" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></label><div class="form-error" hidden></div><button class="btn" type="submit">${esc(t('auth.change_password'))}</button><small class="muted">${esc(t('settings.password_hint'))}</small></form>`;
    };
    const load = async () => {
      try { status = await P.api('email.status'); render(); clearInterval(timer); if (status.resend_after > 0) timer = setInterval(() => { if (page.closed) return clearInterval(timer); status.resend_after--; if (status.resend_after <= 0) clearInterval(timer); const b = $('[data-email-resend]', page.el); if (b) { b.disabled = status.resend_after > 0; b.textContent = status.resend_after > 0 ? t('email.resend_in', { seconds: status.resend_after }) : t('email.resend'); } }, 1000); }
      catch (error) { page.body.innerHTML = errorBlock(error); }
    };
    render(); load();
    page.el.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, data = Object.fromEntries(new FormData(form)), button = $('[type=submit]', form);
      button.classList.add('loading');
      try {
        if (form.matches('[data-email-set]')) { status = await P.post('email.set', data); P.toast(t('email.code_sent_toast'), 'success'); load(); }
        if (form.matches('[data-email-verify]')) { status = await P.post('email.verify', { code: data.code }); state.user.email = status.email; state.user.email_verified = true; P.toast(t('email.verified_toast'), 'success'); render(); }
        if (form.id === 'password-form') {
          if (data.new_password !== data.confirm_password) throw { code: 'password_mismatch' };
          const result = await P.post('auth.password', { current_password: data.current_password, new_password: data.new_password });
          if (result.user) state.user = result.user;
          form.reset();
          P.toast(t('settings.password_success'), 'success');
        }
      } catch (error) { const e = $('.form-error', form); if (e) { e.hidden = false; e.textContent = P.errText(error); } else P.failed(error); }
      finally { button.classList.remove('loading'); }
    });
    page.el.addEventListener('click', async event => {
      if (event.target.closest('[data-email-resend]')) { try { status = await P.post('email.resend', {}); P.toast(t('email.code_sent_toast'), 'success'); load(); } catch (error) { P.failed(error); } }
      if (event.target.closest('[data-email-unlink]')) {
        const password = await PU.confirm({ title: t('email.unlink'), text: t('email.unlink_text'), confirm: t('email.unlink'), danger: true, input: { label: t('auth.current_password'), type: 'password', autocomplete: 'current-password' } });
        if (!password) return;
        try {
          const result = await P.post('email.unlink_request', { password });
          if (result.unlinked) { P.toast(t('email.unlinked'), 'success'); state.user.email = null; load(); return; }
          const code = await PU.confirm({ title: t('email.unlink'), text: t('email.unlink_code', { email: result.email }), confirm: t('email.unlink'), danger: true, input: { label: t('email.code'), autocomplete: 'one-time-code' } });
          if (!code) return;
          await P.post('email.unlink_confirm', { code });
          state.user.email = null;
          P.toast(t('email.unlinked'), 'success');
          load();
        } catch (error) { P.failed(error); }
      }
    });
  }

  /* ---------- Folders ---------- */
  function foldersPage() {
    const page = Pages.subpage(t('folders.title'));
    const render = () => {
      page.body.innerHTML = `<p class="hint">${esc(t('folders.hint'))}</p><div class="group-card list">${state.folders.map(f => `<button class="list-item" data-edit-folder="${f.id}"><span class="li-icon ic-orange">${icon('folder')}</span><span class="li-body"><strong>${esc(f.name)}</strong><small>${esc([...f.types.map(x => t(`folders.type_${x}`)), f.conversation_ids.length ? t('folders.chats_count', { count: f.conversation_ids.length }) : ''].filter(Boolean).join(', '))}</small></span>${icon('chevron')}</button>`).join('')}<button class="list-item" data-edit-folder="new"><span class="li-icon ic-green">${icon('plus')}</span><span class="li-body"><strong>${esc(t('folders.create'))}</strong></span></button></div>`;
    };
    render();
    page.el.addEventListener('click', event => {
      const b = event.target.closest('[data-edit-folder]');
      if (!b) return;
      const folder = state.folders.find(f => String(f.id) === b.dataset.editFolder) || { name: '', types: [], conversation_ids: [] };
      const s = PU.sheet({ title: folder.id ? folder.name : t('folders.create'), full: PU.isMobile(), body: `<form class="form"><label class="field"><span>${esc(t('folders.name'))}</span><input name="name" required maxlength="24" value="${esc(folder.name)}"></label><div class="field"><span>${esc(t('folders.include_types'))}</span>${['direct', 'group', 'channel', 'unread'].map(x => `<label class="option-row"><span class="li-body">${esc(t(`folders.type_${x}`))}</span><input type="checkbox" name="types" value="${x}" ${folder.types.includes(x) ? 'checked' : ''}></label>`).join('')}</div><div class="field"><span>${esc(t('folders.include_chats'))}</span><div class="list" style="max-height:260px;overflow:auto">${state.conversations.filter(c => c.type !== 'saved').map(c => `<label class="list-item">${P.convAvatar(c, 'sm')}<span class="li-body"><strong>${esc(P.convName(c))}</strong></span><input type="checkbox" name="ids" value="${c.id}" ${folder.conversation_ids.includes(c.id) ? 'checked' : ''}></label>`).join('')}</div></div><div class="form-error" hidden></div><button class="btn primary block" type="submit">${esc(t('common.save'))}</button>${folder.id ? `<button type="button" class="btn danger block" data-delete-folder="${folder.id}">${esc(t('folders.delete'))}</button>` : ''}</form>` });
      s.el.addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try { state.folders = (await P.post('folders.save', { id: folder.id, name: f.get('name'), types: f.getAll('types'), conversation_ids: f.getAll('ids').map(Number) })).folders; s.close(); render(); }
        catch (error) { const el = $('.form-error', s.el); el.hidden = false; el.textContent = P.errText(error); }
      });
      s.el.addEventListener('click', async e => { const d = e.target.closest('[data-delete-folder]'); if (d) { try { state.folders = (await P.post('folders.delete', { id: Number(d.dataset.deleteFolder) })).folders; state.filter = 'all'; s.close(); render(); } catch (error) { P.failed(error); } } });
    });
  }

  /* ---------- Sticker packs ---------- */
  async function stickersPage() {
    const page = Pages.subpage(t('stickers.title'));
    const render = packs => {
      page.body.innerHTML = `<p class="hint">${esc(t('stickers.hint'))}</p>${packs.map(p => `<div class="group-title">${esc(p.title)}${p.system ? ' · PingUp' : ''}</div><div class="group-card pad" style="padding:10px"><div class="emoji-grid sticker-grid">${p.stickers.map(st => `<span style="position:relative;display:grid;place-items:center"><img src="${esc(st.url)}" alt="${esc(st.emoji)}" width="72" height="72" loading="lazy">${p.owned ? `<button class="attach-remove" data-remove-sticker="${st.id}" aria-label="${esc(t('common.remove'))}">${icon('close')}</button>` : ''}</span>`).join('')}${p.owned && p.stickers.length < 60 ? `<button class="shot-add" data-add-sticker="${p.id}" aria-label="${esc(t('stickers.add'))}">${icon('plus')}</button>` : ''}</div>${p.owned ? `<button class="btn danger small" data-delete-pack="${p.id}">${esc(t('stickers.delete_pack'))}</button>` : !p.system ? `<button class="btn small" data-uninstall-pack="${p.id}">${esc(t('stickers.remove_pack'))}</button>` : ''}</div>`).join('')}<div class="pad"><button class="btn primary block" data-create-pack>${icon('plus')}${esc(t('stickers.create_pack'))}</button></div>`;
    };
    const load = async () => { try { render((await P.api('stickers.packs')).packs); } catch (error) { page.body.innerHTML = errorBlock(error); } };
    page.el.addEventListener('click', async event => {
      const el = event.target.closest('button');
      if (!el) return;
      try {
        if (el.hasAttribute('data-create-pack')) {
          const title = await PU.confirm({ title: t('stickers.create_pack'), confirm: t('common.create'), input: { label: t('stickers.pack_name') } });
          if (title) render((await P.post('stickers.pack_create', { title })).packs);
        }
        if (el.dataset.addSticker) {
          const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/webp,image/gif' });
          input.onchange = async () => {
            if (!input.files[0]) return;
            try { const file = await P.uploadFile(input.files[0], 'sticker'); render((await P.post('stickers.add', { pack_id: Number(el.dataset.addSticker), file_id: file.id })).packs); }
            catch (error) { P.failed(error); }
          };
          input.click();
        }
        if (el.dataset.removeSticker) render((await P.post('stickers.remove', { sticker_id: Number(el.dataset.removeSticker) })).packs);
        if (el.dataset.deletePack && await PU.confirm({ title: t('stickers.delete_pack'), confirm: t('delete.confirm'), danger: true })) render((await P.post('stickers.pack_delete', { pack_id: Number(el.dataset.deletePack) })).packs);
        if (el.dataset.uninstallPack) render((await P.post('stickers.uninstall', { pack_id: Number(el.dataset.uninstallPack) })).packs);
      } catch (error) { P.failed(error); }
    });
    page.body.innerHTML = loading;
    load();
  }

  /* ---------- Starred / language / about ---------- */
  async function starredPage() {
    const page = Pages.subpage(t('starred.title'));
    page.body.innerHTML = loading;
    try {
      const data = await P.api('messages.starred');
      page.body.innerHTML = data.messages.length ? `<div class="group-card list">${data.messages.map(m => { const c = P.findConversation(m.conversation_id); return `<button class="list-item" data-star-jump="${m.id}" data-conversation="${m.conversation_id}">${c ? P.convAvatar(c, 'sm') : ''}<span class="li-body"><strong>${esc(c ? P.convName(c) : '')}</strong><small>${esc(P.messagePreview(m))}</small></span><span class="li-value">${esc(P.listTime(m.created_at))}</span></button>`; }).join('')}</div>` : P.empty('star', t('starred.empty'), t('starred.hint'));
      page.el.addEventListener('click', event => { const b = event.target.closest('[data-star-jump]'); if (b) { page.close(); setTimeout(() => window.PingUpChat?.open(Number(b.dataset.conversation), { messageId: Number(b.dataset.starJump) }), 280); } });
    } catch (error) { page.body.innerHTML = errorBlock(error); }
  }
  function languagePage() {
    const page = Pages.subpage(t('settings.language'));
    page.body.innerHTML = `<div class="group-card radio-list">${[['uk', 'Українська'], ['ru', 'Русский'], ['en', 'English']].map(([code, name]) => `<label><input type="radio" name="lang" value="${code}" ${state.locale === code ? 'checked' : ''}><span>${name}</span></label>`).join('')}</div>`;
    page.el.addEventListener('change', async event => { if (event.target.name === 'lang') { page.close(); await P.changeLocale(event.target.value); P.setPage('settings', { replace: true }); } });
  }
  function aboutPage() {
    const page = Pages.subpage(t('settings.about'));
    const standalone = matchMedia('(display-mode: standalone)').matches;
    page.body.innerHTML = `<div class="profile-hero"><img src="assets/logo.svg" width="64" height="74" alt=""><h2>PingUp ${esc(P.VERSION)}</h2><p>${esc(t('common.app_tagline'))}</p></div><div class="group-card list"><button class="list-item" data-install-pingup><span class="li-icon ic-violet">${icon('download')}</span><span class="li-body"><strong>${esc(t('pwa.title'))}</strong><small>${esc(t(standalone ? 'pwa.installed' : 'pwa.install_hint'))}</small></span></button>${row('help', 'green', t('feedback.title'), { attrs: 'data-open-section="feedback"' })}</div><p class="hint">${esc(t('settings.about_text'))}</p>`;
  }

  /* ---------- Feedback centre (user) ---------- */
  const FEEDBACK_CATEGORIES = {
    bug: ['app', 'messages', 'calls', 'notifications', 'interface', 'files', 'channels', 'premium', 'other'],
    idea: ['interface', 'chats', 'channels', 'calls', 'privacy', 'premium', 'performance', 'other'],
    question: ['account', 'privacy', 'premium', 'channels', 'other'],
  };
  const statusPill = status => `<span class="status-pill ${esc(status)}">${esc(t(`feedback.status_${status}`))}</span>`;
  function feedbackHub() {
    const page = Pages.subpage(t('feedback.title'));
    let filter = 'all';
    const load = async () => {
      const target = $('[data-tickets]', page.el);
      target.innerHTML = loading;
      try {
        const data = await P.api('feedback.list', { status: filter });
        state.feedbackUnread = data.unread;
        P.updateNavCounts();
        target.innerHTML = data.tickets.length ? `<div class="group-card list">${data.tickets.map(ticketRow).join('')}</div>` : P.empty('help', t('feedback.no_tickets'), t('feedback.no_tickets_hint'));
      } catch (error) { target.innerHTML = errorBlock(error); }
    };
    page.body.innerHTML = `<div class="group-card list">${row('bug', 'red', t('feedback.report_bug'), { hint: t('feedback.report_bug_hint'), attrs: 'data-feedback-new="bug"' })}${row('bulb', 'orange', t('feedback.suggest_idea'), { hint: t('feedback.suggest_idea_hint'), attrs: 'data-feedback-new="idea"' })}${row('help', 'blue', t('feedback.ask_question'), { hint: t('feedback.ask_question_hint'), attrs: 'data-feedback-new="question"' })}</div><div class="group-title">${esc(t('feedback.my_tickets'))}</div><div class="chips">${['all', 'open', 'need_info', 'fixed', 'closed'].map(s => `<button class="chip ${s === filter ? 'active' : ''}" data-ticket-filter="${s}">${esc(t(s === 'all' ? 'chat.all' : s === 'open' ? 'feedback.filter_open' : `feedback.status_${s}`))}</button>`).join('')}</div><div data-tickets></div>`;
    page.el.addEventListener('click', event => {
      const f = event.target.closest('[data-ticket-filter]');
      if (f) { filter = f.dataset.ticketFilter; $$('[data-ticket-filter]', page.el).forEach(b => b.classList.toggle('active', b === f)); load(); }
    });
    P.on('feedback-changed', () => { if (!page.closed) load(); });
    load();
  }
  function ticketRow(ticket) {
    return `<button class="list-item" data-open-ticket="${ticket.id}" ${ticket.unread ? 'style="font-weight:700"' : ''}><span class="li-icon ic-${ticket.type === 'bug' ? 'red' : ticket.type === 'idea' ? 'orange' : 'blue'}">${icon(ticket.type === 'bug' ? 'bug' : ticket.type === 'idea' ? 'bulb' : 'help')}</span><span class="li-body"><strong>#${ticket.id} · ${esc(ticket.title)}</strong><small>${esc(t(`feedback.cat_${ticket.category}`))} · ${esc(P.listTime(ticket.updated_at))}${ticket.last_message ? ' · ' + esc((ticket.last_message.staff ? t('feedback.team') + ': ' : '') + ticket.last_message.body) : ''}</small></span>${statusPill(ticket.status)}${ticket.unread ? '<b class="badge">•</b>' : ''}</button>`;
  }
  function techInfo() {
    return { app_version: P.VERSION, user_agent: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform || '', language: navigator.language, viewport: `${innerWidth}x${innerHeight}`, screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, standalone: matchMedia('(display-mode: standalone)').matches, theme: document.documentElement.dataset.theme, online: navigator.onLine, page: state.page, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  /* Screenshot picker shared by user forms and staff replies: previews, removal, upload on submit. */
  function shotPicker(container, limit = 5) {
    const files = [];
    const render = () => {
      container.innerHTML = `<div class="shot-grid">${files.map((f, i) => `<div class="shot">${f.type.startsWith('image/') ? `<img src="${f.preview}" alt="">` : `<span class="doc-icon" style="margin:auto">${icon('file')}</span>`}<button type="button" class="attach-remove" data-remove-shot="${i}" aria-label="${esc(t('chat.remove_attachment'))}">${icon('close')}</button></div>`).join('')}${files.length < limit ? `<button type="button" class="shot-add" data-add-shot aria-label="${esc(t('feedback.add_screenshot'))}">${icon('camera')}</button>` : ''}</div>`;
    };
    container.addEventListener('click', event => {
      if (event.target.closest('[data-add-shot]')) {
        const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'image/*,.pdf,.txt,.json,.zip,.mp4,.webm' });
        input.onchange = () => {
          for (const file of [...input.files].slice(0, limit - files.length)) {
            if (file.size > 10 * 1048576) { P.toast(t('feedback.file_too_big'), 'error'); continue; }
            file.preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
            files.push(file);
          }
          render();
        };
        input.click();
      }
      const remove = event.target.closest('[data-remove-shot]');
      if (remove) { const [f] = files.splice(Number(remove.dataset.removeShot), 1); if (f?.preview) URL.revokeObjectURL(f.preview); render(); }
    });
    render();
    return { files, upload: async () => { const ids = []; for (const f of files) ids.push((await P.uploadFile(f, 'feedback')).id); return ids; } };
  }
  Pages.feedbackForm = (type = 'bug', category = '', title = '') => {
    const categories = FEEDBACK_CATEGORIES[type];
    const s = PU.sheet({ title: t(type === 'bug' ? 'feedback.report_bug' : type === 'idea' ? 'feedback.suggest_idea' : 'feedback.ask_question'), full: PU.isMobile(), body: `<form class="form" data-feedback-form><label class="field"><span>${esc(t('feedback.category'))}</span><select name="category" required>${categories.map(c => `<option value="${c}" ${c === category ? 'selected' : ''}>${esc(t(`feedback.cat_${c}`))}</option>`).join('')}</select></label><label class="field"><span>${esc(t(type === 'idea' ? 'feedback.idea_title' : 'feedback.subject'))}</span><input name="title" required minlength="3" maxlength="120" value="${esc(title)}"></label><label class="field"><span>${esc(t('feedback.description'))}</span><textarea name="description" required minlength="10" maxlength="5000" rows="6" placeholder="${esc(t(type === 'bug' ? 'feedback.bug_placeholder' : 'feedback.idea_placeholder'))}"></textarea></label><div class="field"><span>${esc(t(type === 'bug' ? 'feedback.screenshots' : 'feedback.image_optional'))}</span><div data-shots></div><small>${esc(t('feedback.files_hint'))}</small></div>${type === 'bug' ? `<label class="consent"><input type="checkbox" name="tech_consent" checked><span>${esc(t('feedback.tech_consent'))}</span></label>` : ''}<div class="form-error" hidden></div><button class="btn primary block" type="submit">${icon('send')}${esc(t('feedback.send'))}</button></form>` });
    const picker = shotPicker($('[data-shots]', s.el), 5);
    s.el.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, f = new FormData(form), button = $('[type=submit]', form);
      button.classList.add('loading');
      try {
        const fileIds = await picker.upload();
        const consent = f.get('tech_consent') === 'on';
        const result = await P.post('feedback.create', { type, category: f.get('category'), title: f.get('title'), description: f.get('description'), file_ids: fileIds, tech_consent: consent, tech_info: consent ? techInfo() : undefined });
        s.close();
        P.toast(t('feedback.sent', { id: result.ticket.id }), 'success', { action: t('feedback.open'), onAction: () => Pages.openTicket(result.ticket.id) });
        P.emit('feedback-changed');
      } catch (error) { const e = $('.form-error', form); e.hidden = false; e.textContent = P.errText(error); }
      finally { button.classList.remove('loading'); }
    });
  };
  Pages.openTicket = async (id, staff = false) => {
    const s = PU.sheet({ title: `#${id}`, full: true, wide: true, body: loading, footer: '<div data-ticket-footer style="width:100%"></div>' });
    let poller = null;
    const load = async () => {
      try {
        const data = await P.api(staff ? 'admin.feedback.get' : 'feedback.get', { ticket_id: id });
        renderTicket(s, data, staff, load);
      } catch (error) { s.body.innerHTML = errorBlock(error); clearInterval(poller); }
    };
    await load();
    poller = setInterval(() => { if (s.closed) clearInterval(poller); else if (!s.el.contains(document.activeElement) || !document.activeElement.matches('textarea')) load(); }, 15000);
    if (!staff) { state.feedbackUnread = Math.max(0, state.feedbackUnread - 1); P.updateNavCounts(); }
  };
  function renderTicket(s, data, staff, reload) {
    const ticket = data.ticket;
    const meta = `<div class="group-card pad" style="padding:14px;display:grid;gap:8px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${statusPill(ticket.status)}<span class="status-pill">${esc(t(`feedback.type_${ticket.type}`))}</span><span class="status-pill">${esc(t(`feedback.cat_${ticket.category}`))}</span>${staff ? `<span class="status-pill priority-${ticket.priority}">${esc(t(`feedback.priority_${ticket.priority}`))}</span>` : ''}</div><h3>${esc(ticket.title)}</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(ticket.description)}</p>${data.attachments.length ? `<div class="shot-grid">${data.attachments.map(f => attachmentThumb(f)).join('')}</div>` : ''}<small class="muted">${esc(new Date(ticket.created_at * 1000).toLocaleString(state.locale))}${staff && ticket.user ? ` · ${esc(ticket.user.name)} (@${esc(ticket.user.username)})` : ''}</small>${staff && ticket.tech_info ? `<details><summary>${esc(t('feedback.tech_info'))}</summary><pre style="white-space:pre-wrap;font-size:.8em">${esc(JSON.stringify(ticket.tech_info, null, 2))}</pre></details>` : ''}</div>`;
    const controls = staff ? `<div class="pad" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px"><label class="field"><span>${esc(t('feedback.status'))}</span><select data-ticket-status>${['new', 'review', 'need_info', 'in_progress', 'fixed', 'closed', 'rejected'].map(x => `<option value="${x}" ${ticket.status === x ? 'selected' : ''}>${esc(t(`feedback.status_${x}`))}</option>`).join('')}</select></label><label class="field"><span>${esc(t('feedback.priority'))}</span><select data-ticket-priority>${['low', 'normal', 'high', 'critical'].map(x => `<option value="${x}" ${ticket.priority === x ? 'selected' : ''}>${esc(t(`feedback.priority_${x}`))}</option>`).join('')}</select></label></div>` : '';
    const thread = data.messages.map(m => m.kind === 'message'
      ? `<div class="ticket-msg ${m.staff === staff ? 'mine' : ''} ${m.internal ? 'internal' : ''}">${m.internal ? `<strong>${esc(t('feedback.internal_note'))}</strong><br>` : ''}${esc(m.body)}${m.files.length ? `<div class="shot-grid" style="margin-top:6px">${m.files.map(attachmentThumb).join('')}</div>` : ''}<small>${esc(m.staff ? (m.author_name || t('feedback.team')) : (staff ? ticket.user?.name || '' : t('common.you')))} · ${esc(new Date(m.created_at * 1000).toLocaleString(state.locale, { dateStyle: 'short', timeStyle: 'short' }))}</small></div>`
      : `<div class="ticket-event">${esc(m.kind === 'status' ? t('feedback.status_changed', { status: t(`feedback.status_${m.body}`) }) : t('feedback.priority_changed', { priority: t(`feedback.priority_${m.body}`) }))} · ${esc(P.listTime(m.created_at))}</div>`).join('');
    s.body.innerHTML = `${meta}${controls}<div class="ticket-thread pad">${thread || `<p class="hint" style="padding:0">${esc(t(staff ? 'feedback.no_replies_staff' : 'feedback.no_replies'))}</p>`}</div>`;
    const footer = $('[data-ticket-footer]', s.el);
    footer.innerHTML = ticket.can_reply ? `<form class="form" data-ticket-reply style="gap:8px">${staff ? `<div style="display:flex;gap:14px;flex-wrap:wrap"><label class="consent"><input type="checkbox" name="internal"> ${esc(t('feedback.internal_note'))}</label><label class="consent"><input type="checkbox" name="request_info"> ${esc(t('feedback.request_info'))}</label></div>` : ''}<div data-reply-shots></div><div class="composer"><div class="composer-field"><textarea name="body" rows="1" required maxlength="5000" placeholder="${esc(t(staff ? 'feedback.reply_staff' : 'feedback.reply'))}"></textarea></div><button class="send-btn" type="submit" aria-label="${esc(t('common.send'))}">${icon('send')}</button></div></form>` : `<p class="hint" style="padding:0">${esc(t('feedback.closed_note'))}</p>`;
    const picker = ticket.can_reply ? shotPicker($('[data-reply-shots]', footer), 5) : null;
    $('[data-ticket-reply]', footer)?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target, f = new FormData(form), button = $('[type=submit]', form);
      button.classList.add('loading');
      try {
        const fileIds = await picker.upload();
        await P.post(staff ? 'admin.feedback.reply' : 'feedback.reply', { ticket_id: ticket.id, body: f.get('body'), file_ids: fileIds, internal: f.get('internal') === 'on', request_info: f.get('request_info') === 'on' });
        await reload();
        const body = $('.pu-sheet-body', s.el); body.scrollTop = body.scrollHeight;
      } catch (error) { P.failed(error); }
      finally { button.classList.remove('loading'); }
    });
    s.el.onchange = async event => {
      if (!event.target.matches('[data-ticket-status],[data-ticket-priority]')) return;
      try { await P.post('admin.feedback.update', { ticket_id: ticket.id, status: $('[data-ticket-status]', s.el).value, priority: $('[data-ticket-priority]', s.el).value }); P.toast(t('feedback.updated'), 'success'); reload(); P.emit('admin-feedback'); }
      catch (error) { P.failed(error); }
    };
    const body = $('.pu-sheet-body', s.el);
    body.scrollTop = body.scrollHeight;
  }
  function attachmentThumb(f) {
    return f.kind === 'image' ? `<button class="shot" data-ticket-image="${esc(f.url)}" data-name="${esc(f.name)}"><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"></button>` : `<a class="shot" href="${esc(f.url)}&download=1" download style="display:grid;place-items:center">${icon('file')}</a>`;
  }

  /* ---------- Administration ---------- */
  function adminPage() {
    if (state.user.role !== 'admin') return;
    const page = Pages.subpage(t('admin.title'));
    let tab = 'feedback';
    const render = () => {
      page.body.innerHTML = `<div class="chips">${['feedback', 'premium'].map(x => `<button class="chip ${tab === x ? 'active' : ''}" data-admin-tab="${x}">${esc(t(`admin.tab_${x}`))}</button>`).join('')}</div><div data-admin-body></div>`;
      if (tab === 'feedback') adminFeedback($('[data-admin-body]', page.el), page); else adminPremium($('[data-admin-body]', page.el));
    };
    page.el.addEventListener('click', event => { const b = event.target.closest('[data-admin-tab]'); if (b) { tab = b.dataset.adminTab; render(); } });
    render();
  }
  function adminFeedback(container, page) {
    const filters = { status: 'all', type: '', priority: '', sort: 'date', q: '' };
    container.innerHTML = `<div class="pad" style="display:grid;gap:8px"><label class="searchbar" style="margin:0">${icon('search')}<input data-admin-q placeholder="${esc(t('admin.feedback_search'))}"></label><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px"><select data-admin-filter="type"><option value="">${esc(t('admin.all_types'))}</option>${['bug', 'idea', 'question'].map(x => `<option value="${x}">${esc(t(`feedback.type_${x}`))}</option>`).join('')}</select><select data-admin-filter="priority"><option value="">${esc(t('admin.all_priorities'))}</option>${['critical', 'high', 'normal', 'low'].map(x => `<option value="${x}">${esc(t(`feedback.priority_${x}`))}</option>`).join('')}</select><select data-admin-filter="sort">${['date', 'oldest', 'status', 'priority'].map(x => `<option value="${x}">${esc(t(`admin.sort_${x}`))}</option>`).join('')}</select></div></div><div class="chips" data-admin-status></div><div data-admin-list>${loading}</div>`;
    const load = async () => {
      const target = $('[data-admin-list]', container);
      try {
        const data = await P.api('admin.feedback.list', filters);
        const c = data.counts;
        state.admin = { ...(state.admin || {}), feedback_unread: c.unread };
        P.updateNavCounts();
        $('[data-admin-status]', container).innerHTML = ['all', 'new', 'review', 'need_info', 'in_progress', 'fixed', 'closed', 'rejected'].map(x => `<button class="chip ${filters.status === x ? 'active' : ''}" data-admin-status-filter="${x}">${esc(t(x === 'all' ? 'chat.all' : `feedback.status_${x}`))} · ${x === 'all' ? c.total : c[x]}</button>`).join('');
        target.innerHTML = `<p class="hint">${esc(t('admin.feedback_counts', { total: c.total, ideas: c.ideas, unread: c.unread }))}</p>${data.tickets.length ? `<div class="group-card list">${data.tickets.map(ticket => ticketRow(ticket).replace('data-open-ticket', 'data-open-admin-ticket').replace('</strong>', `</strong><small>${esc(ticket.user ? '@' + ticket.user.username : '')} · <span class="priority-${ticket.priority}">${esc(t(`feedback.priority_${ticket.priority}`))}</span> · ${ticket.message_count} ${esc(t('admin.messages_short'))}</small>`)).join('')}</div>` : P.empty('help', t('admin.no_tickets'))}`;
      } catch (error) { target.innerHTML = errorBlock(error); }
    };
    container.addEventListener('click', event => {
      const s = event.target.closest('[data-admin-status-filter]');
      if (s) { filters.status = s.dataset.adminStatusFilter; load(); }
      const open = event.target.closest('[data-open-admin-ticket]');
      if (open) Pages.openTicket(Number(open.dataset.openAdminTicket), true);
    });
    container.addEventListener('change', event => { const f = event.target.dataset.adminFilter; if (f) { filters[f] = event.target.value; load(); } });
    container.addEventListener('input', PU.debounce(event => { if (event.target.matches('[data-admin-q]')) { filters.q = event.target.value.trim(); load(); } }, 350));
    P.on('admin-feedback', () => { if (!page.closed) load(); });
    load();
  }
  function adminPremium(container) {
    container.innerHTML = `<label class="searchbar">${icon('search')}<input data-admin-user-q placeholder="${esc(t('admin.user_search'))}"></label><div data-admin-users>${loading}</div>`;
    const load = async q => {
      const target = $('[data-admin-users]', container);
      try {
        const data = await P.api('admin.users.search', { q });
        target.innerHTML = `<div class="group-card list">${data.users.map(u => `<button class="list-item" data-admin-user="${u.id}">${P.avatar(u, 'sm')}<span class="li-body"><strong>${esc(u.name)}${P.badges(u)}</strong><small>@${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}</small></span>${u.premium_info.active ? `<span class="status-pill fixed">${esc(u.premium_info.forever ? t('premium.forever_short') : t('premium.until_short', { date: P.listTime(u.premium_info.ends_at) }))}</span>` : ''}${icon('chevron')}</button>`).join('')}</div>`;
      } catch (error) { target.innerHTML = errorBlock(error); }
    };
    container.addEventListener('input', PU.debounce(event => { if (event.target.matches('[data-admin-user-q]')) load(event.target.value.trim()); }, 350));
    container.addEventListener('click', event => { const b = event.target.closest('[data-admin-user]'); if (b) adminUser(Number(b.dataset.adminUser), () => load($('[data-admin-user-q]', container).value.trim())); });
    load('');
  }
  async function adminUser(userId, refresh) {
    const s = PU.sheet({ title: t('admin.premium_title'), wide: true, body: loading });
    const render = data => {
      const p = data.premium;
      s.body.innerHTML = `<div class="list-item">${P.avatar(data.user, 'lg')}<span class="li-body"><strong>${esc(data.user.name)}${P.badges(data.user)}</strong><small>@${esc(data.user.username)}</small><small>${esc(p.active ? (p.forever ? t('premium.forever') : t('premium.until', { date: P.longDate(p.ends_at) })) : t('premium.not_active'))}</small></span></div><div class="group-title">${esc(t(p.active ? 'admin.extend' : 'admin.grant'))}</div><div class="chips">${[7, 30, 90, 365].map(d => `<button class="chip" data-grant="${d}">${esc(t('admin.days', { count: d }))}</button>`).join('')}<button class="chip" data-grant="forever">${esc(t('premium.forever_short'))}</button></div><label class="field pad"><span>${esc(t('admin.note'))}</span><input data-grant-note maxlength="300"></label>${p.active ? `<div class="pad"><button class="btn danger block" data-revoke>${esc(t('admin.revoke'))}</button></div>` : ''}<div class="group-title">${esc(t('admin.history'))}</div><div class="list">${data.subscriptions.map(x => `<div class="list-item"><span class="li-icon ${x.state === 'active' ? 'ic-premium' : 'ic-gray'}">${icon('crown')}</span><span class="li-body"><strong>${esc(t(`premium.state_${x.state}`))} · ${esc(t(`premium.source_${x.source}`))}</strong><small>${esc(P.longDate(x.starts_at))} — ${x.ends_at ? esc(P.longDate(x.ends_at)) : esc(t('premium.no_end'))}${x.granted_by_name ? ' · ' + esc(x.granted_by_name) : ''}${x.note ? ' · ' + esc(x.note) : ''}</small></span></div>`).join('') || `<p class="hint">${esc(t('admin.no_history'))}</p>`}</div><div class="group-title">${esc(t('admin.audit'))}</div><div class="list">${data.audit.map(a => `<div class="list-item"><span class="li-icon ic-gray">${icon('shield')}</span><span class="li-body"><strong>${esc(t(`audit.${a.action}`))}</strong><small>${esc(a.actor_name || '—')} · ${esc(new Date(a.created_at * 1000).toLocaleString(state.locale))}${a.details?.days ? ' · ' + esc(t('admin.days', { count: a.details.days })) : a.action === 'premium.grant' || a.action === 'premium.extend' ? ' · ' + esc(t('premium.forever_short')) : ''}</small></span></div>`).join('') || `<p class="hint">${esc(t('admin.no_history'))}</p>`}</div>`;
    };
    const load = async () => { try { render(await P.api('admin.premium.history', { user_id: userId })); } catch (error) { s.body.innerHTML = errorBlock(error); } };
    s.el.addEventListener('click', async event => {
      const g = event.target.closest('[data-grant]');
      if (g) {
        const days = g.dataset.grant === 'forever' ? null : Number(g.dataset.grant);
        if (!await PU.confirm({ title: t('admin.confirm_grant'), text: days ? t('admin.days', { count: days }) : t('premium.forever'), confirm: t('admin.grant') })) return;
        try { render(await P.post('admin.premium.grant', { user_id: userId, days, note: $('[data-grant-note]', s.el)?.value || '' })); P.toast(t('admin.granted'), 'success'); refresh(); if (userId === state.user.id) P.poll(); }
        catch (error) { P.failed(error); }
      }
      if (event.target.closest('[data-revoke]')) {
        if (!await PU.confirm({ title: t('admin.revoke'), text: t('admin.revoke_text'), confirm: t('admin.revoke'), danger: true })) return;
        try { render(await P.post('admin.premium.revoke', { user_id: userId, note: $('[data-grant-note]', s.el)?.value || '' })); P.toast(t('admin.revoked'), 'success'); refresh(); }
        catch (error) { P.failed(error); }
      }
    });
    load();
  }

  /* ---------- Events ---------- */
  document.addEventListener('click', async event => {
    const el = event.target.closest('button,a');
    if (!el) return;
    const d = el.dataset;
    if (d.openSection) { event.stopPropagation(); Pages.openSection(d.openSection); return; }
    if (el.hasAttribute('data-open-saved')) { const saved = state.conversations.find(c => c.type === 'saved'); if (saved) window.PingUpChat?.open(saved.id); return; }
    if (d.feedbackNew) { Pages.feedbackForm(d.feedbackNew, d.feedbackCategory || ''); return; }
    if (d.openTicket) { Pages.openTicket(Number(d.openTicket)); return; }
    if (d.ticketImage) { PU.viewer([{ url: d.ticketImage, kind: 'image', name: d.name }], 0, $('img', el)); return; }
    if (d.dismissBanner) { el.closest('.premium-banner')?.remove(); save({ dismiss_banner: d.dismissBanner }).catch(() => {}); return; }
    if (d.themeChoice) { P.changeTheme(d.themeChoice); return; }
    if (el.hasAttribute('data-push-toggle')) { try { if (state.settings.system) await window.PingUpExperience.disablePush(); else await window.PingUpExperience.enablePush(); } catch (error) { P.failed(error); } }
  }, true);
  P.on('ready', () => { if (state.premium?.active === false && state.premium?.expired) P.toast(t('premium.expired_notice'), 'info', { action: t('premium.learn'), onAction: () => Pages.openSection('premium') }); });
})();
