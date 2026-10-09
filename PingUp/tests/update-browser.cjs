'use strict';
/*
 * Browser regression for message deletion, call logs, channels and motion settings on the PingUp 2.1 UI.
 * Disposable loopback server only (creates accounts). Requires Playwright (NODE_PATH or global install).
 *   PINGUP_TEST_URL=http://127.0.0.1:8080/ PINGUP_BROWSER_EXECUTABLE=/path/to/chromium node tests/update-browser.cjs
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const base = process.env.PINGUP_TEST_URL || 'http://127.0.0.1:8190/';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Disposable loopback server required');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PINGUP_BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const errors = [], users = [];
  const password = crypto.randomBytes(24).toString('base64url') + 'A1!';
  try {
    for (let i = 0; i < 3; i++) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
      const guest = await context.request.get(base + 'api.php?action=bootstrap').then(r => r.json());
      const response = await context.request.post(base + 'api.php?action=auth.register', { headers: { 'X-CSRF-Token': guest.data.csrf }, data: { name: 'Update ' + i, username: 'upd' + crypto.randomBytes(5).toString('hex'), password, locale: 'en' } }).then(r => r.json());
      assert(response.ok, JSON.stringify(response.error));
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      const person = { context, page, ...response.data };
      person.api = async (action, data = {}, post = false, expected = 200) => {
        const url = new URL('api.php', base);
        url.searchParams.set('action', action);
        if (!post) for (const [k, v] of Object.entries(data)) url.searchParams.set(k, v);
        const r = post ? await context.request.post(url.href, { headers: { 'X-CSRF-Token': person.csrf }, data }) : await context.request.get(url.href);
        const result = await r.json();
        assert.equal(r.status(), expected, action + ': ' + JSON.stringify(result.error));
        return result.data || result.error;
      };
      users.push(person);
    }
    const [a, b, c] = users;
    const direct = await a.api('conversations.create', { type: 'direct', user_id: b.user.id }, true);
    const send = async (text, who = a, id = direct.id) => who.api('messages.send', { conversation_id: id, text, client_id: crypto.randomUUID() }, true);
    const message = await send('Delete personally');
    const stable = await send('Keep this row stable');
    const row = (page, id) => page.locator(`[data-message-id="${id}"]`);
    // Opens the context menu of a message (right click on desktop) and chooses a menu entry.
    const menuAction = async (page, id, menuId) => {
      await row(page, id).locator('.bubble').click({ button: 'right' });
      await page.locator(`[data-menu-id="${menuId}"]`).click();
    };

    await a.page.goto(base + '?chat=' + direct.id);
    await row(a.page, stable.id).waitFor();
    const secondTab = await a.context.newPage();
    secondTab.on('pageerror', e => errors.push(e.message));
    await secondTab.goto(base + '?chat=' + direct.id);
    await row(secondTab, message.id).waitFor();
    await b.page.goto(base + '?chat=' + direct.id);
    await row(b.page, message.id).waitFor();
    await a.page.evaluate(id => { window.stableRow = document.querySelector(`[data-message-id="${id}"]`); }, stable.id);

    // Delete only for me: disappears in both of A's tabs, stays for B, neighbour row is not rebuilt.
    await menuAction(a.page, message.id, 'delete');
    await a.page.locator('[data-menu-id="delete-self"]').click();
    await row(a.page, message.id).waitFor({ state: 'detached' });
    await row(secondTab, message.id).waitFor({ state: 'detached', timeout: 15000 });
    assert.equal(await row(b.page, message.id).count(), 1, 'other user retains personally hidden message');
    assert(await a.page.evaluate(id => window.stableRow === document.querySelector(`[data-message-id="${id}"]`), stable.id));

    // In a direct chat the recipient may delete an incoming message for everyone.
    await menuAction(b.page, stable.id, 'delete');
    await b.page.locator('[data-menu-id="delete-everyone"]').click();
    await row(a.page, stable.id).waitFor({ state: 'detached', timeout: 15000 });

    // One call card per call, even after a repeated end.
    const call = await a.api('calls.start', { user_id: b.user.id, kind: 'audio', device_id: 'test-caller-device' }, true);
    await b.api('calls.accept', { call_id: call.call.id, device_id: 'test-callee-device' }, true);
    await a.api('calls.end', { call_id: call.call.id, device_id: 'test-caller-device' }, true);
    await a.api('calls.end', { call_id: call.call.id, device_id: 'test-caller-device' }, true);
    await b.page.waitForFunction(() => { const d = document.querySelector('.pu-call-dialog'); return !d?.open || d.dataset.state === 'ended'; });
    if (await b.page.locator('.pu-call-dialog[open]').count()) await b.page.locator('[data-call="close"]').click();
    const list = await a.api('messages.list', { conversation_id: direct.id });
    assert.equal(list.messages.filter(m => m.call?.id === call.call.id).length, 1);
    await a.page.locator('.chat-call-card').waitFor({ timeout: 15000 });
    assert.match(await a.page.locator('.chat-call-card').innerText(), /Call ended/);
    const quiet = await a.api('sync', { conversation_id: direct.id, after_id: Math.max(...list.messages.map(m => m.id)), after_change_seq: list.change_cursor });
    assert.deepEqual(quiet.updated_messages, []);
    assert.deepEqual(quiet.messages, []);

    // Channel creation through the single "+" entry point.
    await a.page.locator('.list-pane .app-bar [data-action="create-menu"]').click();
    await a.page.locator('[data-menu-id="create-channel"]').click();
    await a.page.locator('#community-form [name="name"]').fill('PingUp Updates');
    await a.page.locator('#community-form [name="description"]').fill('Announcements and <safe> text');
    await a.page.locator('#community-form [data-visibility="public"]').click();
    const slug = 'news_' + crypto.randomBytes(5).toString('hex');
    await a.page.locator('#community-form [name="slug"]').fill(slug);
    await a.page.locator('#community-form [data-preset-pick="dark_neon"]').click();
    await a.page.locator('#community-form [type="submit"]').click();
    await a.page.locator('.chat-person strong').filter({ hasText: 'PingUp Updates' }).waitFor();
    assert.equal(await a.page.locator('.chat-screen').getAttribute('data-preset'), 'dark_neon', 'channel appearance is applied');
    const channel = (await a.api('conversations.list')).find(x => x.slug === slug);
    assert(channel);
    const search = await c.api('channels.search', { q: slug.toUpperCase() });
    assert(search.channels.some(x => x.id === channel.id));

    // Discover and join from the Channels tab; readers get no composer.
    await b.page.locator('.rail [data-page="channels"]').click();
    await b.page.locator('#discover-search').fill(slug);
    await b.page.locator(`[data-join-public="${channel.id}"]`).click();
    await b.page.locator('.channel-readonly').waitFor();
    assert.equal(await b.page.locator('#message-input').count(), 0);
    await b.api('messages.send', { conversation_id: channel.id, text: 'forbidden', client_id: crypto.randomUUID() }, true, 403);
    await c.api('channels.update', { conversation_id: channel.id, name: 'Takeover' }, true, 404);
    await b.api('channels.update', { conversation_id: channel.id, name: 'Takeover' }, true, 403);
    const post = await send('Channel post', a, channel.id);
    await row(b.page, post.id).waitFor({ timeout: 15000 });

    // Owner edits the description in community management.
    await a.page.locator('[data-action="chat-info"]').click();
    await a.page.locator('[data-manage-community]').click();
    await a.page.locator('[data-manage-section="info"]').click();
    await a.page.locator('#community-info-form [name="description"]').fill('Updated description');
    await a.page.locator('#community-info-form [type="submit"]').click();
    await a.page.waitForFunction(() => !document.querySelector('#community-info-form'));
    assert.equal((await a.api('conversations.list')).find(x => x.id === channel.id).description, 'Updated description');

    // A removed subscriber loses the open channel without a reload.
    await a.api('channels.update', { conversation_id: channel.id, remove_user_ids: [b.user.id] }, true);
    await b.page.waitForFunction(() => !document.querySelector('.chat-person')?.textContent.includes('PingUp Updates'), null, { timeout: 15000 });
    await b.api('messages.list', { conversation_id: channel.id }, false, 404);

    // Private channel: invite deep link, rotation, leave.
    const privateChannel = await a.api('conversations.create', { type: 'channel', name: 'Private room', visibility: 'private' }, true);
    assert(privateChannel.invite_token);
    assert(!(await c.api('channels.search', { q: 'Private room' })).channels.some(x => x.id === privateChannel.id));
    await c.page.goto(base + '?invite=' + privateChannel.invite_token);
    // The link only previews the channel; membership starts with the explicit button.
    await c.page.locator('.community-preview [data-preview-join]').waitFor();
    assert(!(await c.api('conversations.list')).some(x => x.id === privateChannel.id), 'opening an invite must not subscribe');
    await c.page.locator('.community-preview [data-preview-join]').click();
    await c.page.locator('.chat-person strong').filter({ hasText: 'Private room' }).waitFor();
    const rotated = await a.api('channels.update', { conversation_id: privateChannel.id, rotate_invite: true }, true);
    assert.notEqual(rotated.invite_token, privateChannel.invite_token);
    await b.api('channels.join', { invite_token: privateChannel.invite_token }, true, 404);
    await c.api('channels.leave', { conversation_id: privateChannel.id }, true);
    await c.api('messages.list', { conversation_id: privateChannel.id }, false, 404);

    // Animation preference persists across reloads; prefers-reduced-motion is respected.
    await a.page.locator('.rail [data-page="settings"]').click();
    await a.page.locator('[data-open-section="appearance"]').click();
    const motion = a.page.locator('.subpage.open [data-setting="motion"]');
    await motion.uncheck();
    await a.page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
    await a.page.reload();
    await a.page.locator('.app-shell').waitFor();
    await a.page.locator('.rail [data-page="settings"]').click();
    await a.page.locator('[data-open-section="appearance"]').click();
    await motion.waitFor();
    assert(!(await motion.isChecked()));
    assert.equal(await a.page.evaluate(() => document.documentElement.dataset.motion), 'off');
    await a.page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await a.page.evaluate(() => getComputedStyle(document.querySelector('.page-enter')).animationDuration), '0.001s');
    await b.page.setViewportSize({ width: 390, height: 844 });
    await b.page.reload();
    await b.page.locator('.app-shell').waitFor();
    assert(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
    console.log('PASS: personal deletion across tabs, incoming deletion for everyone, stable DOM, single call log, empty deltas, channel create (+ menu, preset)/discover/join/manage/invite rotation/leave/permissions, persisted motion and reduced-motion, mobile width. No media connection claimed.');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
