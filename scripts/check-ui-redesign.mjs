import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, PASSWORDS, docForm } from '../tests/helpers.js';
import { makeDocx } from '../tests/fixtures.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const out = process.env.UI_SCREENSHOTS;
if (out) fs.mkdirSync(out, { recursive: true });
const ctx = await setup();
let browser;
try {
  const operator = ctx.client;
  assert.equal((await operator.login('ADM900', PASSWORDS.admin)).status, 200);
  async function post(resource, body) {
    const res = await operator.request('POST', '/api/' + resource, { body, multipart: body instanceof FormData });
    assert.equal(res.status, 200, resource);
    return res.data.data.id;
  }
  const kind = await post('vidy-rabot', { name: 'Электромонтажные работы' });
  const work = await post('raboty', { name: 'Проверка комплекта рабочей документации', vidId: kind,
    instruction: 'Откройте перечень листов.\nСверьте обозначения и редакции с ведомостью.' });
  await post('raboty', { name: 'Работа без инструкции', vidId: kind });
  const article = new FormData();
  for (const [key, value] of Object.entries({ title: 'Обозначения на рабочих чертежах', rabotaId: work, content: 'Справочник обозначений и разделов проектной документации.' })) article.append(key, value);
  await post('articles', article);
  const documentTitle = 'Акт освидетельствования кабельных трасс';
  const file = new File([makeDocx({ paragraphs: ['Контрольный текст редакции'] })], 'акт.docx',
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const documentId = await post('pto', docForm({ objectId: ctx.objectA, title: documentTitle, type: 'Исполнительная документация',
    dueDate: '2026-11-24', file, cipher: 'ЭОМ-АКТ-014' }));
  const status = await operator.request('PATCH', '/api/pto/' + documentId + '/status', { body: { status: 'На проверке' } });
  assert.equal(status.status, 200);
  await post('pto', docForm({ objectId: ctx.objectA, title: 'Журнал входного контроля материалов', type: 'Журнал работ', dueDate: '2026-11-26' }));
  await post('remarks', { objectId: ctx.objectA, description: 'Уточнить обозначение листа в ведомости', documentId });
  await post('completeness', { objectId: ctx.objectA, name: 'Исполнительная документация по электроснабжению' });
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(7000);
  await page.route('**/*', (r) => r.request().url().startsWith(ctx.base + '/') ? r.continue() : r.abort());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const el = (id) => page.locator('#' + id);
  const snap = async (name) => { if (out) await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); };
  async function login(tab, password) {
    await el('tab-number').fill(tab);
    await el('password').fill(password);
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#dashboard-stats .number').first().waitFor();
  }
  async function go(name) {
    await el('nav-toggle').click();
    await el('nav-' + name).click();
    assert.ok(!await el('drawer').isVisible());
    assert.equal(await el('nav-' + name).getAttribute('aria-current'), 'page');
  }
  async function logout() {
    await el('nav-toggle').click();
    await el('logout-btn').click();
    await el('tab-number').waitFor();
  }
  async function fits(label) {
    const sizes = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
    assert.ok(sizes[1] <= sizes[0], label + ' ' + sizes.join('/'));
  }
  await page.goto(ctx.base);
  await page.locator('.login-header img').evaluate((img) => img.decode());
  await snap('01-login');
  await login('PTO901', PASSWORDS.pto2);

  for (const [width, height] of [[1920,1080],[1366,900],[768,1024],[390,844]]) {
    await page.setViewportSize({ width, height });
    await go('dashboard');
    await el('dashboard-docs').getByText(documentTitle).waitFor();
    await fits('Панель ' + width);
    await snap('dashboard-' + width);
    const x = (await page.locator('main').boundingBox()).x;
    await el('nav-toggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'drawer-close');
    assert.equal((await page.locator('main').boundingBox()).x, x);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
    assert.ok(!await el('nav-users').isVisible());
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.querySelector('#drawer').contains(document.activeElement)));
    if (width === 390) await snap('drawer-390');
    await el('drawer-close').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'logout-btn');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#drawer').open);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-toggle');
    await el('nav-toggle').click();
    await page.mouse.click(width - 2, 90);
    assert.ok(!await el('drawer').isVisible());
    await go('pto');
    await el('pto-list').getByText(documentTitle).waitFor();
    assert.ok(!await el('pto-list').getByText('ИД объекта Б').count());
    await fits('Реестр ' + width);
    if (width === 1366 || width === 390) await snap('registry-' + width);
    await el('pto-list').getByText(documentTitle).click();
    await el('modal-body').getByRole('button', { name: /Просмотреть/ }).first().click();
    await el('viewer-body').getByText('Контрольный текст редакции').first().waitFor();
    await fits('Просмотр ' + width);
    if (width === 1366) await snap('document-preview');
    await el('viewer-close').click();
    await el('modal-close').click();
    await el('show-add-doc').click();
    await el('pto-doc-form').waitFor();
    await fits('Форма ' + width);
    if (width === 390) await snap('document-form-390');
    await el('modal-close').click();
    await go('executive');
    assert.equal(await el('pto-filter-type').inputValue(), 'Исполнительная документация');
    await go('pto');
    assert.equal(await el('pto-filter-type').inputValue(), 'all');
    console.log('Пройдена ширина ' + width);
  }

  await el('show-add-doc').click();
  await el('pto-form-object').selectOption(String(ctx.objectA));
  await el('pto-form-title').fill('Документ мобильной проверки');
  await page.locator('#pto-doc-form button[type=submit]').click();
  await el('modal-body').getByRole('button', { name: /Редактировать/ }).click();
  await el('pto-form-title').fill('Документ после редактирования');
  await page.locator('#pto-doc-form button[type=submit]').click();
  await el('modal-body').getByRole('heading', { name: 'Документ после редактирования' }).waitFor();
  await el('modal-close').click();
  await go('objects');
  await el('objects-list').getByText('Объект А (тест)').waitFor();
  await go('remarks');
  await el('show-add-remark').click();
  await el('remark-object').selectOption(String(ctx.objectA));
  await el('remark-description').fill('Контрольное замечание с телефона');
  await page.locator('#remark-form button[type=submit]').click();
  await el('remarks-list').getByText('Контрольное замечание с телефона').waitFor();
  await go('completeness');
  await el('completeness-list').getByText('Исполнительная документация по электроснабжению').click();
  await el('show-add-set').click();
  await el('set-name').fill('Комплект мобильной проверки');
  await el('set-object').selectOption(String(ctx.objectA));
  await page.locator('#set-form button[type=submit]').click();
  await el('completeness-list').getByText('Комплект мобильной проверки').waitFor();
  await go('reports');
  await page.locator('#report-stats .number').first().waitFor();
  await el('global-search-btn').click();
  await el('global-search').fill('кабельных');
  await el('global-search').press('Enter');
  await page.locator('.search-result').filter({ hasText: documentTitle }).click();
  await el('modal-close').click();
  await el('notifications-btn').click();
  await el('modal-body').getByText(documentTitle, { exact: false }).first().waitFor();
  await el('modal-close').click();
  await el('profile-btn').click();
  await el('password-form').waitFor();
  await el('modal-close').click();
  await go('about');
  await page.locator('#about-page .brand').evaluate((img) => img.decode());
  await fits('О компании');
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.locator('.toast').first().waitFor({ state: 'hidden' });
  await snap('about');
  await go('catalog');
  await el('search-input').fill('Обозначения');
  await el('articles-list').getByText('Обозначения на рабочих чертежах').waitFor();
  await snap('knowledge');
  await go('instructions');
  await el('instruction-list').locator('summary').first().click();
  assert.ok(!(await el('instruction-list').textContent()).includes('Работа без инструкции'));
  await snap('instructions');
  await el('instruction-list').getByText('Обозначения на рабочих чертежах').click();
  await el('modal-body').getByRole('heading', { name: 'Обозначения на рабочих чертежах' }).waitFor();
  await el('modal-close').click();
  assert.ok(await page.locator('#instruction-list details').getAttribute('open') !== null);
  await logout();

  for (const [tab, password, content, admin] of [
    ['M900', PASSWORDS.worker, false, false], ['M900', PASSWORDS.worker, true, false], ['ADM900', PASSWORDS.admin, true, true]
  ]) {
    if (tab === 'M900' && content) ctx.db.prepare('UPDATE Сотрудник SET Должность = ? WHERE ID_сотрудника = ?').run('Старший монтажник', ctx.byTab.M900);
    await login(tab, password);
    await el('nav-toggle').click();
    assert.equal(await el('nav-add-article').isVisible(), content);
    assert.equal(await el('nav-users').isVisible(), admin);
    await el('drawer-close').click();
    await go('about');
    assert.equal(await el('project-photo-add').isVisible(), admin);
    if (admin) {
      const jpeg = await page.evaluate(() => document.createElement('canvas').toDataURL('image/jpeg').split(',')[1]);
      const picker = page.waitForEvent('filechooser');
      await el('project-photo-add').click();
      await (await picker).setFiles({ name: 'объект.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
      await page.locator('#project-gallery img').evaluate(img => img.decode());
      await go('users');
      await el('users-page').getByRole('heading', { name: 'Управление сотрудниками' }).waitFor();
    } else {
      await go('instructions');
      await page.locator('#instruction-list summary').first().waitFor();
      await go('pto');
      assert.ok(!await el('show-add-doc').isVisible());
    }
    await logout();
  }
  await login('PTO901', PASSWORDS.pto2);
  await page.setViewportSize({ width: 390, height: 844 });
  await go('about');
  assert.equal(await el('project-photo-add').isVisible(), false);
  await page.locator('#project-gallery button').click();
  await page.locator('#project-photo img').evaluate(img => img.decode());
  await fits('Фотография объекта на телефоне');
  assert.deepEqual(errors, []);
  console.log('Пройдены четыре роли, формы, поиск, уведомления, материалы, компания и смена сессии.');
} finally {
  await browser?.close();
  await ctx.close();
}
