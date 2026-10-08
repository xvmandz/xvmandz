#!/usr/bin/env node
/*
 * Browser regression checks for an isolated local PingUp server.
 * Requires Playwright installed separately. This project has no Node runtime
 * dependency. PINGUP_PLAYWRIGHT_MODULE may point to a installed module path.
 *
 * Usage:
 *   PINGUP_TEST_INVITE_CODE=... node tests/browser-smoke.cjs \
 *     --base-url http://127.0.0.1:8080
 *
 * Creates two random accounts; use disposable storage and PINGUP_MAX_USERS=0.
 * Test passwords exist only in memory and are never logged.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function args() {
  const result = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    assert.ok(['--base-url', '--invite-code', '--browser-executable'].includes(key), `Unknown option ${key}`);
    assert.ok(process.argv[i + 1], `Missing value for ${key}`);
    result[key.slice(2)] = process.argv[i + 1];
  }
  assert.ok(result['base-url'], '--base-url is required');
  const url = new URL(result['base-url']);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Use an isolated loopback server; tests create real data');
  assert.ok(['http:', 'https:'].includes(url.protocol));
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  result['base-url'] = url.toString().replace(/\/?$/, '/');
  return result;
}

async function main() {
  const options = args();
  const { chromium, request } = require(process.env.PINGUP_PLAYWRIGHT_MODULE || 'playwright');
  const baseURL = options['base-url'];
  const invite = options['invite-code'] || process.env.PINGUP_TEST_INVITE_CODE || '';
  const prefix = 'ui' + crypto.randomBytes(4).toString('hex');
  const password = crypto.randomBytes(24).toString('base64url') + 'A1!';
  const contexts = [];
  let browser;
  const errors = [];

  async function api(context, action, payload, csrf) {
    const response = payload === undefined
      ? await context.get(`api.php?action=${encodeURIComponent(action)}`)
      : await context.post(`api.php?action=${encodeURIComponent(action)}`, {
        data: payload, headers: { 'X-CSRF-Token': csrf },
      });
    const data = await response.json();
    assert.equal(response.ok() && data.ok, true, `${action}: HTTP ${response.status()}, ${data.error?.code || ''}`);
    return data.data;
  }

  try {
    const people = [];
    for (let index = 0; index < 2; index++) {
      const context = await request.newContext({ baseURL });
      contexts.push(context);
      const guest = await api(context, 'bootstrap');
      const identity = await api(context, 'auth.register', {
        username: `${prefix}_${index}`, name: index ? 'Browser Bob' : 'Browser Alice',
        password, invite_code: invite, locale: 'en',
      }, guest.csrf);
      people.push({ context, ...identity });
    }
    const [alice, bob] = people;
    const conversation = await api(alice.context, 'conversations.create', {
      type: 'direct', user_id: bob.user.id,
    }, alice.csrf);
    const firstText = 'Stable existing bubble ' + prefix;
    const first = await api(bob.context, 'messages.send', {
      conversation_id: conversation.id, text: firstText,
      client_id: 'browser-first:' + crypto.randomUUID(),
    }, bob.csrf);
    await api(alice.context, 'auth.logout', {}, alice.csrf);

    browser = await chromium.launch({
      headless: true,
      ...(options['browser-executable'] ? { executablePath: options['browser-executable'] } : {}),
    });
    const ui = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
    contexts.push(ui);
    const page = await ui.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('#auth-form').waitFor();
    const username = page.locator('#auth-form input[name="username"], #auth-form input[name="identifier"]');
    await username.fill(alice.user.username);
    await page.locator('#auth-form input[name="password"]').fill(password);
    await page.locator('#auth-form button[type="submit"]').click();
    await page.locator('.app-shell').waitFor();
    assert.equal(await page.locator('#auth-form').count(), 0, 'Successful UI login must show the app');
    await page.locator(`[data-open-conversation="${conversation.id}"]`).first().click();
    await page.locator('#message-input').waitFor();
    await page.locator(`[data-message-id="${first.id}"]`).waitFor();
    await page.evaluate(id => {
      window.__pingupOriginalRow = document.querySelector(`[data-message-id="${id}"]`);
      window.__pingupOriginalLog = document.querySelector('.messages-area');
      window.__pingupOriginalComposer = document.querySelector('#message-form');
    }, first.id);

    // Hold the send response long enough to inspect the optimistic message.
    let releaseSend;
    const held = new Promise(resolve => { releaseSend = resolve; });
    await page.route('**/api.php?action=messages.send*', async route => {
      await held;
      await route.continue();
    });
    const outgoing = 'Optimistic message ' + prefix;
    await page.locator('#message-input').fill(outgoing);
    await page.locator('#message-input').press('Enter');
    await page.locator('.message-group.pending').filter({ hasText: outgoing }).waitFor();
    assert.equal(await page.locator('#message-input').inputValue(), '', 'Composer clears without a page render');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'message-input');
    assert.equal(await page.evaluate(() => window.__pingupOriginalRow.isConnected), true);
    releaseSend();
    await page.locator('.message-group.own:not(.pending)').filter({ hasText: outgoing }).waitFor();
    await page.unroute('**/api.php?action=messages.send*');

    // Two polling cycles must preserve existing DOM nodes and typed drafts.
    await page.locator('#message-input').fill('Draft stays while polling');
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.waitForResponse(response => response.url().includes('action=sync') && response.ok(), { timeout: 15000 });
    }
    assert.equal(await page.evaluate(id => window.__pingupOriginalRow === document.querySelector(`[data-message-id="${id}"]`), first.id), true, 'Polling replaced an unchanged message bubble');
    assert.equal(await page.evaluate(() => window.__pingupOriginalLog === document.querySelector('.messages-area')), true, 'Sending/polling rebuilt the message log');
    assert.equal(await page.evaluate(() => window.__pingupOriginalComposer === document.querySelector('#message-form')), true, 'Sending/polling rebuilt the composer');
    assert.equal(await page.locator('#message-input').inputValue(), 'Draft stays while polling');

    const inert = `<img src=x onerror="window.__pingupXss=1"> ${prefix}`;
    const incoming = await api(bob.context, 'messages.send', {
      conversation_id: conversation.id, text: inert,
      client_id: 'browser-incoming:' + crypto.randomUUID(),
    }, bob.csrf);
    const incomingRow = page.locator(`[data-message-id="${incoming.id}"]`);
    await incomingRow.waitFor({ timeout: 15000 });
    assert.equal(await incomingRow.locator('.message-text').textContent(), inert, 'Message text must be rendered verbatim');
    assert.equal(await incomingRow.locator('.message-text img').count(), 0);
    assert.equal(await page.evaluate(() => window.__pingupXss), undefined);
    assert.equal(await page.locator('#message-input').inputValue(), 'Draft stays while polling');

    // Appearance/locales persist through the authenticated profile settings.
    await page.locator('[data-page="settings"]').first().click();
    await page.locator('[data-theme-choice="light"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    for (const language of ['uk', 'ru', 'en']) {
      await page.locator(`[data-language="${language}"]`).click();
      await page.waitForFunction(lang => document.documentElement.lang === lang, language);
      assert.ok(await page.locator('.settings-page h1').textContent());
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.app-shell').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');

    // The mobile chat is a separate screen with a working back action.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.mobile-nav [data-page="chats"]').click();
    const row = page.locator(`.conversation-list [data-open-conversation="${conversation.id}"]`);
    await row.click();
    await page.locator('#message-input').waitFor();
    assert.equal(await page.locator('.app-shell.mobile-chat-open').count(), 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `Mobile interface overflows by ${overflow}px`);
    await page.locator('[data-action="chat-back"]').click();
    await row.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.app-shell.mobile-chat-open').count(), 0);
    assert.deepEqual(errors, [], 'Unhandled browser errors');
    console.log('PASS: UI login, optimistic send, stable messages/composer, incoming delivery, inert message HTML, light theme, uk/ru/en, mobile chat.');
  } finally {
    if (browser) await browser.close();
    for (const context of contexts.reverse()) await context.dispose?.();
  }
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
