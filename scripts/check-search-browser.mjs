// Запуск с установленным Playwright: node scripts/check-search-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, docForm, PASSWORDS } from '../tests/helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const ctx = await setup();
let browser;
try {
  const title = '<i>Карта работ</i>';
  const content = '🧱 <b>Кабель</b> & <mark>сверка</mark>';
  assert.equal((await ctx.client.login('ADM900', PASSWORDS.admin)).status, 200);
  for (const [index, objectId] of [ctx.objectA, ctx.objectB, null].entries()) {
    const form = docForm({ objectId, title: index ? 'Закрытая карта' : title, content });
    assert.equal((await ctx.client.request('POST', '/api/pto', { body: form, multipart: true })).status, 200);
  }

  for (let index = 0; index < 14; index++) {
    const body = docForm({ objectId: ctx.objectA, title: 'Ведомость ' + index });
    assert.equal((await ctx.client.request('POST', '/api/pto', { body, multipart: true })).status, 200);
  }

  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.request().url().startsWith(ctx.base + '/') ? route.continue() : route.abort());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(ctx.base);
  await page.locator('#tab-number').fill('PTO901');
  await page.locator('#password').fill(PASSWORDS.pto2);
  await page.locator('#login-form button[type=submit]').click();
  const search = page.locator('#global-search');
  const results = page.locator('#global-search-results');

  for (const engine of ['fts5', 'like']) {
    ctx.db.__ftsUnavailable = engine === 'like';
    const done = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/search');
    await search.fill('Кабель');
    assert.equal((await (await done).json()).engine, engine);
    const button = page.locator('#global-search-results .search-result');
    await button.locator('mark').waitFor();
    assert.equal(await button.count(), 1);
    assert.equal(await button.locator('i,b').count(), 0);
    assert.deepEqual(await button.locator('mark').allTextContents(), ['Кабель']);
    assert.ok((await button.textContent()).includes(title));
    assert.ok((await button.textContent()).includes(content));
    await button.click();
    await page.locator('#modal-close').click();
    // Очистка через интерфейс исключает чтение результата предыдущего запроса.
    await page.locator('#global-search').fill('а');
    await page.locator('#global-search-btn').click();
    await page.locator('#global-search-results .compact-empty').waitFor();
    console.log('Проверены поиск, подсветка и открытие карточки — ' + engine);
  }
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 800 });
    if (!await search.isVisible()) await page.locator('#global-search-btn').click();
    await search.fill('Ведо');
    const options = results.locator('.search-result');
    await options.nth(13).waitFor({ state: 'visible' });
    assert.ok(await results.evaluate(el => el.scrollHeight > el.clientHeight));
    assert.ok(await results.evaluate(el => el.getBoundingClientRect().right <= window.innerWidth));
    for (let index = 0; index < 14; index++) await page.keyboard.press('ArrowDown');
    assert.ok(await options.last().evaluate(el => el === document.activeElement));
    assert.ok(await results.evaluate(el => el.scrollTop > 0));
    await page.keyboard.press('Enter');
    await page.locator('#modal-close').click();
    if (!await search.isVisible()) await page.locator('#global-search-btn').click();
    await search.fill('Ведом');
    await options.first().waitFor();
    await search.fill('');
    assert.ok(await results.isHidden());
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await ctx.close();
}
