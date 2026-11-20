import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {setup,PASSWORDS} from '../tests/helpers.js';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH||'playwright-core');
const ctx=await setup();
let browser;
try {
  const out=process.env.UI_SCREENSHOTS;
  if(out) fs.mkdirSync(out,{recursive:true});
  await ctx.client.login('ADM900',PASSWORDS.admin);
  const result=await ctx.client.request('POST','/api/sotrudniki',{body:{fullName:'Волков Алексей Викторович',tabNumber:'LEAD900',role:'Руководитель',password:PASSWORDS.admin}});
  assert.equal(result.status,200);
  assert.equal((await ctx.client.request('POST','/api/tasks',{body:{objectId:ctx.objectA,title:'Принять комплект схем',assigneeId:ctx.byTab.PTO900}})).status,200);
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE,headless:true});
  const p=await browser.newPage();
  const errors=[];
  p.on('pageerror',err=>errors.push(err.message));
  await p.route('**/*',route=>route.request().url().startsWith(ctx.base+'/')?route.continue():route.abort());
  const el=id=>p.locator('#'+id);
  async function go(name){await el('nav-toggle').click();await el('nav-'+name).click();}
  await p.goto(ctx.base);
  await el('tab-number').fill('LEAD900');await el('password').fill(PASSWORDS.admin);
  await p.locator('#login-form button[type=submit]').click();
  await el('dashboard-role').getByText('Руководитель').waitFor();
  for(const [width,height] of [[1920,1080],[1366,900],[768,1024],[390,844]]){
    await p.setViewportSize({width,height});
    await go('dashboard');
    await el('dashboard-object').selectOption(String(ctx.objectA));
    const count=p.locator('#dashboard-stats .number').first();
    await p.waitForFunction(()=>document.querySelector('#dashboard-stats .number')?.textContent==='1');
    await el('dashboard-object').selectOption('all');
    await p.waitForFunction(()=>document.querySelector('#dashboard-stats .number')?.textContent==='2');
    assert.equal(await count.textContent(),'2');
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(out) await p.screenshot({path:path.join(out,'dashboard-'+width+'.png')});
    await el('nav-toggle').click();
    assert.equal(await el('nav-users').isVisible(),false);
    await el('nav-tasks').click();
    await el('task-rows').getByRole('button',{name:'Принять комплект схем'}).click();
    await el('task-edit').waitFor();
    assert.equal(await p.locator('[data-transition=start]').count(),0);
    assert.equal(await p.locator('[data-transition=cancel]').count(),1);
    if(out) await p.screenshot({path:path.join(out,'task-'+width+'.png')});
    await el('task-close').click();
    await go('pto');
    assert.equal(await el('show-add-doc').isVisible(),false);
    console.log('Руководитель: проверена ширина '+width);
  }
  assert.deepEqual(errors,[]);
} finally {await browser?.close();await ctx.close();}
