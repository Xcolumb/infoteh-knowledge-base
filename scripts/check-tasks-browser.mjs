import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, PASSWORDS } from '../tests/helpers.js';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const ctx = await setup();
const out = process.env.TASK_SCREENSHOTS;
let browser;
try {
  if (out) fs.mkdirSync(out, { recursive: true });
  assert.equal((await ctx.client.login('ADM900', PASSWORDS.admin)).status, 200);
  async function request(method, endpoint, body) {
    const result = await ctx.client.request(method, '/api/tasks'+endpoint, { body });
    assert.equal(result.status, 200, result.text);
    return result.data.data;
  }
  const names = ['Сверить ведомость кабельных линий', 'Проверить журнал входного контроля',
    'Согласовать исполнительную схему', 'Подготовить комплект актов'];
  const date = new Date();
  date.setUTCDate(date.getUTCDate()-1);
  for (const [i,title] of names.entries()) {
    let task = await request('POST','',{ title, objectId:ctx.objectA, assigneeId:ctx.byTab.PTO901,
      priority:i === 0 ? 'Высокий' : 'Обычный', dueDate:i === 0 ? date.toISOString().slice(0,10) : null,
      description:'Сверить материалы объекта и передать результат на проверку.' });
    const actions = [[],['start'],['start','submit'],['start','submit','accept']][i];
    for (const action of actions) task = await request('POST','/'+task.id+'/transitions',{ action,version:task.version });
  }
  await request('POST','',{ title:'Сверка другого объекта', objectId:ctx.objectB, assigneeId:ctx.byTab.PTO900 });
  browser = await chromium.launch({ executablePath:process.env.BROWSER_EXECUTABLE, headless:true });
  const errors=[];
  async function login(tab,password,width=1366) {
    const page = await browser.newPage({ viewport:{width,height:900}, reducedMotion:'reduce' });
    page.setDefaultTimeout(8000);
    await page.route('**/*', route => route.request().url().startsWith(ctx.base+'/') ? route.continue() : route.abort());
    page.on('pageerror', error=>errors.push(error.message));
    await page.goto(ctx.base);
    await page.locator('#tab-number').fill(tab);
    await page.locator('#password').fill(password);
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#dashboard-stats .number').first().waitFor();
    return page;
  }
  async function tasks(page) {
    await page.locator('#nav-toggle').click();
    await page.locator('#nav-tasks').click();
    await page.locator('#task-metrics button').first().waitFor();
  }
  async function rows(page,n) {
    await page.waitForFunction(n=>document.querySelectorAll('#task-rows [data-task]').length === n,n);
  }
  async function card(page,title) {
    await page.locator('#task-rows').getByRole('button',{name:title,exact:true}).click();
    await page.locator('.task-title').getByText(title,{exact:true}).waitFor();
  }
  async function status(page,value) {
    await page.locator('#task-body > .status-badge').filter({hasText:value}).waitFor();
  }
  async function snap(page,name) {
    if (out) await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});
  }
  async function fits(page) {
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  }
  const engineer=await login('PTO901',PASSWORDS.pto2);
  await tasks(engineer);
  for (const [width,height] of [[1920,1080],[1366,900],[768,1024],[390,844]]) {
    await engineer.setViewportSize({width,height});
    await rows(engineer,4);
    await fits(engineer);
    await snap(engineer,'tasks-'+width);
    await engineer.locator('[data-metric=overdue]').click();
    await rows(engineer,1);
    await card(engineer,names[0]);
    const box=await engineer.locator('#task-panel').boundingBox();
    assert.equal(Math.round(box.x+box.width),width);
    assert.equal(Math.round(box.width),width === 390 ? 390 : 540);
    await engineer.locator('#task-body').getByText('Исполнитель',{exact:true}).waitFor();
    await fits(engineer);
    if ([1366,390].includes(width)) await snap(engineer,'card-'+width);
    await engineer.locator('#task-close').click();
    await engineer.locator('[data-scope=all]').click();
    await rows(engineer,4);
  }
  await engineer.locator('[data-scope=created]').click();
  await rows(engineer,0);
  await engineer.locator('[data-scope=mine]').click();
  await rows(engineer,4);
  await engineer.locator('#task-q').fill('ВЕДОМОСТЬ');
  await rows(engineer,1);
  await engineer.locator('#task-q').fill('');
  await rows(engineer,4);
  await engineer.locator('#task-status').selectOption('Выполнена');
  await rows(engineer,1);
  await engineer.locator('#task-status').selectOption('');
  await rows(engineer,4);

  const admin=await login('ADM900',PASSWORDS.admin);
  await tasks(admin);
  await rows(admin,5);
  await admin.locator('#task-object').selectOption(String(ctx.objectB));
  await rows(admin,1);
  await admin.locator('#task-object').selectOption('');
  await rows(admin,5);
  await admin.locator('#task-new').click();
  const form=admin.locator('#task-form');
  const title='Проверить привязки щита освещения';
  await form.locator('[name=title]').fill(title);
  await form.locator('[name=description]').fill('Сопоставить обозначения на схеме и в ведомости.');
  await form.locator('[name=objectId]').selectOption(String(ctx.objectA));
  await form.locator('[name=assigneeId]').selectOption(String(ctx.byTab.PTO901));
  assert.deepEqual((await form.locator('[name=assigneeId] option').evaluateAll(nodes=>nodes.map(n=>n.value))).sort(),
    ['',String(ctx.byTab.PTO900),String(ctx.byTab.PTO901)].sort());
  await form.locator('[name=priority]').selectOption('Высокий');
  await snap(admin,'task-editor');
  await form.locator('button[type=submit]').click();
  await status(admin,'Новая');
  await admin.locator('#task-edit').click();
  await form.locator('[name=priority]').selectOption('Срочный');
  await form.locator('button[type=submit]').click();
  await admin.locator('#task-body dd').getByText('Срочный',{exact:true}).waitFor();
  await admin.locator('#task-close').click();
  await engineer.locator('#notifications-btn').click();
  await engineer.locator('[data-notice-task]').filter({hasText:title}).first().click();
  await status(engineer,'Новая');
  await engineer.locator('[data-transition=start]').click();
  await status(engineer,'В работе');
  await engineer.locator('#task-comment textarea').fill('Обозначения проверены по схеме.');
  await engineer.locator('#task-comment button').click();
  await engineer.locator('.task-entry p').getByText('Обозначения проверены по схеме.').waitFor();
  await engineer.locator('[data-transition=submit]').click();
  await status(engineer,'На проверке');
  await engineer.locator('#task-close').click();
  await card(admin,title);
  await admin.locator('[data-transition=return]').click();
  await admin.locator('#task-return textarea').fill('Добавить номер листа.');
  await admin.locator('#task-return button').click();
  await status(admin,'В работе');
  await admin.locator('#task-close').click();
  await card(engineer,title);
  await engineer.locator('[data-transition=submit]').click();
  await status(engineer,'На проверке');
  await engineer.locator('#task-close').click();
  await card(admin,title);
  await admin.locator('[data-transition=accept]').click();
  await status(admin,'Выполнена');
  await admin.locator('.task-history summary').click();
  await admin.locator('.task-history').getByText('Добавить номер листа.').waitFor();
  await admin.locator('#task-close').click();

  await admin.locator('#task-new').click();
  await form.locator('[name=title]').fill('Свободная задача');
  assert.equal(await form.locator('[name=assigneeId]').isDisabled(),true);
  await form.locator('[name=objectId]').selectOption(String(ctx.objectA));
  await form.locator('[name=assigneeId]').selectOption('');
  await form.locator('button[type=submit]').click();
  await status(admin,'Новая');
  await admin.locator('#task-body dd').getByText('Не назначен',{exact:true}).waitFor();
  await admin.locator('#task-close').click();
  await engineer.locator('[data-scope=all]').click();
  await card(engineer,'Свободная задача');
  await engineer.locator('[data-transition=claim]').click();
  await status(engineer,'В работе');
  assert.equal(await engineer.locator('#task-body dd').getByText('Не назначен',{exact:true}).count(),0);
  await engineer.locator('#task-close').click();

  for (const role of ['Монтажник','Старший монтажник']) {
    ctx.db.prepare('UPDATE Сотрудник SET Должность=? WHERE ID_сотрудника=?').run(role,ctx.byTab.M900);
    const worker=await login('M900',PASSWORDS.worker);
    await worker.locator('#nav-toggle').click();
    assert.equal(await worker.locator('#nav-tasks').isVisible(),false);
    assert.equal(await worker.locator('#task-metrics').isVisible(),false);
    await worker.locator('#drawer-close').click();
    await worker.locator('#notifications-btn').click();
    await worker.locator('#modal-body h2').waitFor();
    assert.equal(await worker.locator('[data-notice-task]').count(),0);
    await worker.context().close();
  }
  ctx.db.prepare('UPDATE Сотрудник SET Должность=? WHERE ID_сотрудника=?').run('Монтажник',ctx.byTab.PTO901);
  await engineer.locator('#nav-toggle').click();
  await engineer.locator('#dashboard-page').waitFor();
  assert.equal(await engineer.locator('#nav-tasks').getAttribute('hidden'),'');
  assert.equal(await engineer.locator('#task-rows tr').count(),0);
  assert.deepEqual(errors,[]);
  console.log('Пройдены 1920, 1366, 768, 390 px, фильтры, карточка, назначение, комментарий, возврат, приёмка, уведомления и смена роли.');
} finally {
  await browser?.close();
  await ctx.close();
}
