'use strict';
/*
 * PingUp modernisation regression (grows stage by stage) on a disposable loopback server (creates accounts).
 * Stage 1: invite/slug/discover links preview a community and never subscribe on their own; search fields show
 * focus on the whole pill (no inner square outline); contextual empty states with actions; no duplicate Profile row.
 *   PINGUP_TEST_URL=http://127.0.0.1:8080/ PINGUP_BROWSER_EXECUTABLE=/path/to/chromium node tests/modern-browser.cjs
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const base = process.env.PINGUP_TEST_URL || 'http://127.0.0.1:8190/';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Disposable loopback server required');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PINGUP_BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const errors = [];
  const password = crypto.randomBytes(18).toString('base64url') + 'A1!';
  const people = [];
  try {
    for (const name of ['Owner Olga', 'Reader Rita']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const guest = await context.request.get(base + 'api.php?action=bootstrap').then(r => r.json());
      const registered = await context.request.post(base + 'api.php?action=auth.register', { headers: { 'X-CSRF-Token': guest.data.csrf }, data: { name, username: 'md' + crypto.randomBytes(5).toString('hex'), password, locale: 'en' } }).then(r => r.json());
      assert(registered.ok, JSON.stringify(registered.error));
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
      const person = { context, page, ...registered.data };
      person.api = async (action, data = {}, post = false) => {
        const url = new URL('api.php', base);
        url.searchParams.set('action', action);
        if (!post) for (const [k, v] of Object.entries(data)) url.searchParams.set(k, v);
        const r = post ? await context.request.post(url.href, { headers: { 'X-CSRF-Token': person.csrf }, data }) : await context.request.get(url.href);
        const result = await r.json();
        assert(result.ok, action + ': ' + JSON.stringify(result.error));
        return result.data;
      };
      people.push(person);
    }
    const [owner, reader] = people;
    const page = reader.page;
    const member = async id => (await reader.api('conversations.list')).some(c => c.id === id);

    await page.goto(base);
    await page.locator('.app-shell').waitFor();
    // 3. Empty states explain the section and offer a next step.
    await page.locator('[data-filter="groups"]').click();
    const groupsEmpty = page.locator('.conversation-list .empty, #chat-scroller .empty').first();
    await groupsEmpty.locator('[data-new-community="group"]').waitFor();
    assert(!/^\s*Nothing here yet\s*$/i.test(await groupsEmpty.innerText()));
    await page.locator('[data-filter="unread"]').click();
    await page.locator('#chat-scroller .empty [data-filter="all"]').waitFor();
    await page.locator('#chat-scroller .empty [data-filter="all"]').click();
    await page.locator('.bottom-nav [data-page="calls"]').click();
    await page.locator('#calls-history .empty [data-new-call]').waitFor();

    await page.locator('.bottom-nav [data-page="chats"]').click();
    // 1. Links preview, membership only after the explicit button.
    const slug = 'pv' + crypto.randomBytes(4).toString('hex');
    const pub = await owner.api('conversations.create', { type: 'channel', name: 'Preview news', visibility: 'public', slug, description: 'Daily notes' }, true);
    await owner.api('messages.send', { conversation_id: pub.id, text: 'First public post', client_id: crypto.randomUUID() }, true);
    const priv = await owner.api('conversations.create', { type: 'group', name: 'Secret club', visibility: 'private' }, true);
    await owner.api('messages.send', { conversation_id: priv.id, text: 'Hidden text', client_id: crypto.randomUUID() }, true);

    await page.goto(base + '?join=' + slug);
    const sheet = page.locator('.community-preview');
    await sheet.locator('[data-preview-join]').waitFor();
    assert.match(await sheet.innerText(), /Preview news[\s\S]*Daily notes[\s\S]*First public post/);
    assert.equal(await member(pub.id), false, 'slug link must not subscribe');
    await sheet.locator('[data-preview-close]').click();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await member(pub.id), false, 'cancel keeps the user out');

    await page.goto(base + '?invite=' + priv.invite_token);
    await sheet.locator('[data-preview-join]').waitFor();
    assert(!(await sheet.innerText()).includes('Hidden text'), 'private previews reveal no messages');
    assert.equal(await member(priv.id), false, 'invite link must not subscribe');
    await sheet.locator('[data-preview-join]').click();
    await page.locator('.chat-person strong').filter({ hasText: 'Secret club' }).waitFor();
    assert.equal(await member(priv.id), true);

    // Discover card tap previews too; the reader joins from the sheet.
    await page.goBack();
    await page.locator('.bottom-nav [data-page="channels"]').click();
    await page.locator('#discover-search').fill(slug);
    await page.locator(`[data-community-info="${pub.id}"]`).first().click();
    await sheet.locator('[data-preview-join]').waitFor();
    assert.equal(await member(pub.id), false, 'discover tap must not subscribe');
    await sheet.locator('[data-preview-join]').click();
    await page.locator('.chat-person strong').filter({ hasText: 'Preview news' }).waitFor();
    assert.equal(await member(pub.id), true);
    await page.goBack();

    // 2. Search field focus: ring on the pill, no square outline on the inner input.
    await page.locator('.bottom-nav [data-page="chats"]').click();
    await page.locator('#chat-search').focus();
    const focus = await page.evaluate(() => {
      const input = document.querySelector('#chat-search'), pill = input.closest('.searchbar');
      const i = getComputedStyle(input), p = getComputedStyle(pill);
      return { outline: i.outlineStyle, inputShadow: i.boxShadow, inputBorder: i.borderTopWidth, pillShadow: p.boxShadow, appearance: i.appearance };
    });
    assert.equal(focus.outline, 'none');
    assert.equal(focus.inputShadow, 'none');
    assert.equal(focus.inputBorder, '0px');
    assert.notEqual(focus.pillShadow, 'none', 'focus must stay visible on the pill');
    await page.locator('#chat-search').blur();

    // 4. Settings: the account card is the only Profile entry.
    await page.locator('.bottom-nav [data-page="settings"]').click();
    await page.locator('.account-card').waitFor();
    assert.equal(await page.locator('[data-open-section="profile"]').count(), 1, 'one Profile entry');
    await page.locator('.account-card').click();
    await page.locator('.subpage.open').waitFor();

    // Stage 2. Direct chat header: call, video and search; in-chat search with counts, jump and navigator.
    await page.goBack();
    const direct = await owner.api('conversations.create', { type: 'direct', user_id: reader.user.id }, true);
    const sent = [];
    for (let i = 1; i <= 70; i++) sent.push(await owner.api('messages.send', { conversation_id: direct.id, text: i % 7 === 0 ? `Find the NEEDLE number ${i}` : `Filler line ${i}`, client_id: crypto.randomUUID() }, true));
    const needles = sent.filter((m, i) => (i + 1) % 7 === 0).reverse(); // newest first, 10 matches
    await page.goto(base + '?chat=' + direct.id);
    const head = page.locator('.chat-head');
    for (const action of ['call', 'video-call', 'chat-search']) await head.locator(`[data-action="${action}"]`).waitFor({ state: 'visible', timeout: 10000 });
    await head.locator('[data-action="chat-search"]').click();
    const find = page.locator('.find-page');
    await find.locator('[data-find-summary]').filter({ hasText: '70' }).waitFor();
    await find.locator('[data-find-input]').fill('needle');
    await find.locator('[data-find-summary]').filter({ hasText: 'Matches: 10' }).waitFor();
    assert.equal(await find.locator('.find-row').count(), 10);
    assert.equal(await find.locator('.find-row mark').first().textContent(), 'NEEDLE', 'case-insensitive highlight keeps original text');
    if (process.env.PINGUP_SHOTS) await page.screenshot({ path: process.env.PINGUP_SHOTS + '/find-page.png' });
    const oldest = needles[needles.length - 1];
    await find.locator(`[data-find-id="${oldest.id}"]`).click();
    await find.waitFor({ state: 'detached' });
    const target = page.locator(`.msg[data-message-id="${oldest.id}"]`);
    await target.waitFor();
    await page.waitForFunction(id => { const el = document.querySelector(`.msg[data-message-id="${id}"]`), box = el?.closest('.messages, .scroller, .chat-scroll')?.getBoundingClientRect() || { top: 0, bottom: innerHeight }; const r = el?.getBoundingClientRect(); return r && r.top >= box.top - 2 && r.bottom <= box.bottom + 2; }, oldest.id);
    const nav = page.locator('.find-nav');
    await nav.filter({ hasText: '10 of 10' }).waitFor();
    assert(await nav.locator('.find-up').isDisabled(), 'no older match after the oldest');
    await nav.locator('.find-down').click();
    await nav.filter({ hasText: '9 of 10' }).waitFor();
    await page.locator(`.msg[data-message-id="${needles[8].id}"]`).waitFor();
    if (process.env.PINGUP_SHOTS) await page.screenshot({ path: process.env.PINGUP_SHOTS + '/find-nav.png' });
    await nav.locator('[data-find-open]').click();
    await find.locator('.find-row').first().waitFor();
    assert.equal(await find.locator('[data-find-input]').inputValue(), 'needle', 'search state is kept when reopened');
    await page.goBack();
    await find.waitFor({ state: 'detached' });
    await nav.locator('[data-find-end]').click();
    await nav.waitFor({ state: 'detached' });

    // Global search is a full screen (not a popup); a result opens the chat and the screen closes.
    await page.locator('[data-action="chat-back"]').click();
    await page.locator('.list-pane .app-bar [data-action="search"]').click();
    const screen = page.locator('.search-screen');
    await screen.waitFor();
    assert.equal(await page.locator('.pu-sheet-root').count(), 0, 'no popup sheet');
    const box = await screen.boundingBox();
    assert(box.width >= 389 && box.height >= 700, 'search covers the screen');
    await screen.locator('[data-search-type="messages"]').click();
    await screen.locator('[data-global-search]').fill('number 63');
    await screen.locator(`[data-search-message="${sent[62].id}"]`).click();
    await screen.waitFor({ state: 'detached' });
    await page.locator(`.msg[data-message-id="${sent[62].id}"]`).waitFor();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(overflow <= 1, 'mobile overflow ' + overflow);
    assert.deepEqual(errors, []);
    console.log('PASS: link/discover preview without auto-join (public posts, private hidden), search pill focus, contextual empty states, single Profile entry; direct header call/video/search, in-chat search counts + jump into unloaded history + navigator, full-screen global search.');
  } catch (error) {
    console.error('Browser errors', errors);
    throw error;
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
