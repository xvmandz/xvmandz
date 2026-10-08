'use strict';
/*
 * PingUp 2.1 mobile UX regression on a disposable loopback server (creates accounts).
 * Covers: bottom navigation, universal "+" sheet with Android Back, delivered → read ticks driven by a
 * visible receiver, swipe-to-reply, long-press menu reactions, drafts, global search, feedback with a
 * screenshot, theme personalisation, premium preview lock and channel comments.
 *   PINGUP_TEST_URL=http://127.0.0.1:8080/ PINGUP_BROWSER_EXECUTABLE=/path/to/chromium node tests/messenger21-browser.cjs
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const base = process.env.PINGUP_TEST_URL || 'http://127.0.0.1:8190/';
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Disposable loopback server required');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PINGUP_BROWSER_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const errors = [];
  const password = crypto.randomBytes(18).toString('base64url') + 'A1!';
  const people = [];
  try {
    const layouts = [{ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { viewport: { width: 1366, height: 860 } }];
    for (const [index, layout] of layouts.entries()) {
      const context = await browser.newContext(layout);
      const guest = await context.request.get(base + 'api.php?action=bootstrap').then(r => r.json());
      const username = 'mx' + crypto.randomBytes(5).toString('hex');
      const registered = await context.request.post(base + 'api.php?action=auth.register', { headers: { 'X-CSRF-Token': guest.data.csrf }, data: { name: ['Mila Mobile', 'Dan Desktop'][index], username, password, locale: 'en' } }).then(r => r.json());
      assert(registered.ok, JSON.stringify(registered.error));
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${username}: ${e.message}`));
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
    const [m, d] = people;
    await m.api('contacts.request', { user_id: d.user.id }, true);
    await d.api('contacts.respond', { user_id: m.user.id, accept: true }, true);
    const direct = await m.api('conversations.create', { type: 'direct', user_id: d.user.id }, true);
    const hello = await d.api('messages.send', { conversation_id: direct.id, text: 'Hello from desktop', client_id: crypto.randomUUID() }, true);

    // Mobile shell: five bottom tabs, sliding indicator and the universal "+" sheet.
    const page = m.page;
    await page.goto(base);
    await page.locator('.app-shell').waitFor();
    assert.equal(await page.locator('.bottom-nav .nav-item').count(), 5);
    for (const tab of ['channels', 'contacts', 'calls', 'settings', 'chats']) {
      await page.locator(`.bottom-nav [data-page="${tab}"]`).click();
      await page.locator(`.page[data-page-name="${tab}"]`).waitFor();
    }
    await page.locator('.bottom-nav [data-page="settings"]').click();
    await page.goBack(); // Android Back from another tab returns to Chats.
    await page.locator('.page[data-page-name="chats"]').waitFor();
    await page.locator('.fab').click();
    await page.locator('[data-menu-id="create-group"]').waitFor();
    assert.equal(await page.locator('[data-menu-id^="create-"]').count(), 3, 'one + menu with message/group/channel');
    assert.equal(await page.locator('.new-group-button, [data-action="new-group"]').count(), 0, 'no duplicate create buttons');
    await page.goBack(); // Back closes the sheet, not the app.
    await page.locator('.pu-sheet-root').waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).origin + '/', base);

    // Desktop receiver keeps the app open (delivery) but has not opened the chat yet.
    await d.page.goto(base);
    await d.page.locator('.app-shell').waitFor();

    // Mobile sender: message ticks go sent/delivered → read when the receiver actually views the chat.
    await page.locator(`[data-open-conversation="${direct.id}"]`).click();
    await page.locator('#message-input').waitFor();
    await page.locator('#message-input').fill('Status check');
    await page.locator('.send-btn').click();
    const own = page.locator('.msg.own').filter({ hasText: 'Status check' });
    await own.locator('.ticks[data-status="sent"], .ticks[data-status="delivered"]').waitFor({ timeout: 10000 });
    await own.locator('.ticks[data-status="delivered"]').waitFor({ timeout: 15000 });
    assert.equal(await own.locator('.ticks[data-status="read"]').count(), 0, 'not read before the receiver opens the chat');
    await d.page.locator(`[data-open-conversation="${direct.id}"]`).click();
    await d.page.locator('.msg').filter({ hasText: 'Status check' }).waitFor();
    await own.locator('.ticks[data-status="read"]').waitFor({ timeout: 15000 });

    // Swipe right on an incoming message → reply bar.
    const incoming = page.locator(`[data-message-id="${hello.id}"]`);
    await incoming.waitFor();
    await page.evaluate(id => {
      const el = document.querySelector(`[data-message-id="${id}"] .bubble`);
      const r = el.getBoundingClientRect(), y = r.top + r.height / 2;
      const touch = x => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(r.left + 30)], changedTouches: [touch(r.left + 30)] }));
      for (let x = 40; x <= 140; x += 20) el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(r.left + x)], changedTouches: [touch(r.left + x)] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(r.left + 140)] }));
    }, hello.id);
    await page.locator('.composer-bar').filter({ hasText: 'Dan Desktop' }).waitFor();
    await page.locator('[data-action="clear-reply"]').click();

    // Long press → menu with quick reactions; the reaction reaches the other side.
    await page.evaluate(id => {
      const el = document.querySelector(`[data-message-id="${id}"] .bubble`);
      const r = el.getBoundingClientRect(), t = new Touch({ identifier: 2, target: el, clientX: r.left + 20, clientY: r.top + 10 });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [t], changedTouches: [t] }));
      setTimeout(() => el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [t] })), 700);
    }, hello.id);
    await page.locator('.quick-reactions [data-quick-react="🔥"]').click();
    await incoming.locator('.reaction.mine').filter({ hasText: '🔥' }).waitFor();
    await d.page.locator(`[data-message-id="${hello.id}"] .reaction`).filter({ hasText: '🔥' }).waitFor({ timeout: 15000 });

    // Drafts survive leaving the chat and are synced to the server.
    await page.locator('#message-input').fill('Unsent idea');
    await page.waitForTimeout(1500);
    await page.goBack(); // closes the chat screen
    await page.locator('.chat-row .draft').first().waitFor();
    assert.equal((await m.api('conversations.list')).find(c => c.id === direct.id).draft, 'Unsent idea');

    // Global search finds a contact by @username.
    await page.locator('.list-pane .app-bar [data-action="search"]').click();
    await page.locator('[data-global-search]').fill('@' + d.user.username);
    await page.locator(`.pu-sheet [data-profile="${d.user.id}"]`).waitFor();
    await page.goBack();

    // Feedback with a screenshot from Settings.
    await page.locator('.bottom-nav [data-page="settings"]').click();
    await page.locator('[data-feedback-new="bug"]').first().click();
    await page.locator('[data-feedback-form] [name="title"]').fill('Composer jumps');
    await page.locator('[data-feedback-form] [name="description"]').fill('After rotating the phone the composer jumps up.');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-add-shot]').click();
    await (await chooser).setFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PNG });
    await page.locator('.shot img').waitFor();
    await page.locator('[data-feedback-form] [type="submit"]').click();
    await page.locator('.toast').filter({ hasText: /#\d+/ }).waitFor();
    const tickets = await m.api('feedback.list');
    assert.equal(tickets.tickets[0].title, 'Composer jumps');
    const ticket = await m.api('feedback.get', { ticket_id: tickets.tickets[0].id });
    assert.equal(ticket.attachments.length, 1);

    // Personalisation: free theme applies at once; a premium theme is only previewed for free users.
    await page.locator('[data-open-section="appearance"]').click();
    await page.locator('.subpage.open [data-theme-name="ocean"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.skin === 'ocean');
    await page.locator('.subpage.open [data-theme-name="aurora"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.skin === 'aurora');
    await page.locator('.toast').filter({ hasText: 'Aurora' }).waitFor();
    assert.equal((await m.api('sync')).notification_settings.theme_name, 'ocean', 'locked premium theme is not saved');
    await page.waitForFunction(() => document.documentElement.dataset.skin === 'ocean', null, { timeout: 8000 });
    await page.goBack();

    // Channel comments: subscriber comments under a post; owner sees the counter.
    const slug = 'cm' + crypto.randomBytes(4).toString('hex');
    const channel = await d.api('conversations.create', { type: 'channel', name: 'Comment club', visibility: 'public', slug, settings: { comments_enabled: true } }, true);
    const post = await d.api('messages.send', { conversation_id: channel.id, text: 'What do you think?', client_id: crypto.randomUUID() }, true);
    await m.api('channels.join', { slug }, true);
    await page.locator('.bottom-nav [data-page="chats"]').click();
    await page.locator(`[data-open-conversation="${channel.id}"]`).click();
    await page.locator(`[data-open-thread="${post.id}"]`).click();
    await page.locator('[data-thread-input]').fill('Love it');
    await page.locator('[data-thread-form] [type="submit"]').click();
    await page.locator('[data-thread-list] .msg').filter({ hasText: 'Love it' }).waitFor();
    for (let i = 0; i < 30; i++) {
      const list = await d.api('messages.list', { conversation_id: channel.id });
      if (list.messages.find(x => x.id === post.id)?.comment_count === 1) break;
      assert(i < 29, 'comment count not updated');
      await page.waitForTimeout(200);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(overflow <= 1, 'mobile overflow ' + overflow);
    assert.deepEqual(errors, []);
    console.log('PASS: bottom navigation + Back, single + sheet, sent/delivered/read ticks from real visibility, swipe-to-reply, long-press reactions synced, server drafts, @username search, feedback with screenshot, theme apply + premium preview lock, channel comments, no mobile overflow.');
  } catch (error) {
    console.error('Browser errors', errors);
    throw error;
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
