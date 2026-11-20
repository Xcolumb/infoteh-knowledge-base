import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, createClient, docForm, pdfFile, PASSWORDS} from './helpers.js';

test('Руководитель: глобальное чтение, управление задачами и отзыв роли', async t => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const admin = ctx.client, lead = createClient(ctx.base), engineer = createClient(ctx.base);
  await admin.login('ADM900',PASSWORDS.admin);
  await engineer.login('PTO900',PASSWORDS.pto);
  async function call(client, method, url, body, expected=200) {
    const response = await client.request(method,'/api/'+url,{body,multipart:body instanceof FormData});
    assert.equal(response.status,expected,method+' '+url+' '+response.text.slice(0,240));
    return response.data;
  }
  const person=(await call(admin,'POST','sotrudniki',{fullName:'Руководитель стенда',tabNumber:'LEAD01',role:'Руководитель',password:PASSWORDS.admin})).data;
  await lead.login('LEAD01',PASSWORDS.admin);
  const get=url=>call(lead,'GET',url);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM Доступ_объект WHERE ID_сотрудника=?').pluck().get(person.id),0);
  assert.equal((await get('objects')).data.length,2);
  const obj=(await call(admin,'POST','objects',{name:'Новый участок'})).data.id;
  assert.ok((await get('objects')).data.some(o=>o.id===obj));
  const makeDoc=async(objectId,title)=>(await call(admin,'POST','pto',docForm({objectId,title,file:pdfFile()}))).data.id;
  const classified=await makeDoc(obj,'Сводка участка'),hidden=await makeDoc(null,'Сводка без объекта');
  const rev=id=>ctx.db.prepare('SELECT ID_редакции FROM Редакция_ПТО WHERE ID_документа=?').pluck().get(id);
  assert.equal((await get('reports/summary')).data.total,3);
  assert.equal((await get('reports/summary?objectId='+obj)).data.total,1);
  assert.ok((await get('pto')).data.every(d=>d.objectId));
  for(const path of ['reports/documents.csv','pto/export.csv']) {
    const csv=await get(path); assert.ok(csv.includes('Сводка участка')); assert.ok(!csv.includes('Сводка без объекта'));
  }
  for(const fallback of [false,true]) {
    ctx.db.__ftsUnavailable=fallback;
    const ids=(await get('search?q='+encodeURIComponent('Сводка'))).data.map(x=>x.id);
    assert.ok(ids.includes(classified)); assert.ok(!ids.includes(hidden));
  }
  for(const [id,status] of [[classified,200],[hidden,404]]) {
    for(const url of ['pto/'+id,'files/document/'+id,'files/revision/'+rev(id),'preview/revision/'+rev(id)]) await call(lead,'GET',url,undefined,status);
  }
  const rem=(await call(admin,'POST','remarks',{objectId:obj,description:'Обход участка'})).data.id;
  const set=(await call(admin,'POST','completeness',{objectId:obj,name:'Папка участка'})).data.id;
  await get('remarks/'+rem); await get('completeness/'+set);
  ctx.db.prepare('UPDATE Замечание SET ID_объекта=NULL WHERE ID_замечания=?').run(rem);
  ctx.db.prepare('UPDATE Комплект SET ID_объекта=NULL WHERE ID_комплекта=?').run(set);
  for(const url of ['remarks/'+rem,'completeness/'+set,'completeness/'+set+'/missing.csv']) await call(lead,'GET',url,undefined,404);
  assert.ok(!(await get('reports/remarks.csv')).includes('Обход участка'));
  for(const [method,url] of [['POST','pto'],['PUT','pto/'+classified],['DELETE','pto/'+classified],['PUT','objects/'+obj],['POST','remarks/'+rem+'/comments'],['GET','sotrudniki'],['PUT','sotrudniki/'+person.id+'/role'],['POST','company/photos']]) await call(lead,method,url,undefined,403);
  for(const url of ['settings','backup','restore']) await call(lead,'POST',url,{},404);
  const makeTask=(client,assigneeId)=>call(client,'POST','tasks',{title:'Сверка',objectId:ctx.objectA,assigneeId});
  const free=(await makeTask(lead,null)).data;
  const act=(client,id,action,version,expected,reason)=>call(client,'POST','tasks/'+id+'/transitions',{action,version,reason},expected);
  await act(lead,free.id,'claim',1,403);
  const task=(await makeTask(engineer,ctx.byTab.PTO901)).data;
  const url='tasks/'+task.id;
  for(const id of [person.id,ctx.byTab.ADM900,ctx.byTab.M900]) await call(lead,'PATCH',url,{version:1,assigneeId:id},400);
  await call(lead,'PATCH',url,{version:1,assigneeId:ctx.byTab.PTO900,dueDate:'2027-01-01',priority:'Высокий'});
  await act(lead,task.id,'start',2,403);
  await act(engineer,task.id,'start',2,200);
  await act(lead,task.id,'submit',3,403);
  await act(engineer,task.id,'submit',3,200);
  await act(lead,task.id,'return',4,400);
  await act(lead,task.id,'return',4,200,'Добавить акт');
  await act(engineer,task.id,'submit',5,200);
  await act(lead,task.id,'accept',6,200);
  await act(lead,free.id,'cancel',1,200);
  const assigned=(await makeTask(lead,ctx.byTab.PTO900)).data;
  await act(engineer,assigned.id,'start',1,200);
  await act(engineer,assigned.id,'submit',2,200);
  const mail=(await get('notifications')).data;
  assert.ok(mail.some(n=>n.link==='task:'+assigned.id));
  assert.ok(!mail.some(n=>n.type==='Назначена задача'));
  assert.ok((await get('notifications/unread-count')).unread>0);
  await call(lead,'POST','tasks',{title:'Проверка назначения',objectId:obj,assigneeId:ctx.byTab.PTO900},400);
  ctx.db.prepare('UPDATE Сотрудник SET Заблокирован=1 WHERE ID_сотрудника=?').run(ctx.byTab.PTO901);
  await call(lead,'POST','tasks',{title:'Проверка назначения',objectId:ctx.objectA,assigneeId:ctx.byTab.PTO901},400);
  const previous=(await makeTask(engineer,ctx.byTab.PTO900)).data;
  await call(admin,'PUT','sotrudniki/'+ctx.byTab.PTO900+'/role',{role:'Руководитель'});
  await act(engineer,previous.id,'start',1,403);
  await call(admin,'PUT','sotrudniki/'+person.id+'/role',{role:'Монтажник'});
  assert.equal((await get('objects')).data.length,0);
  assert.equal((await get('notifications')).data.filter(n=>n.link?.startsWith('task:')).length,0);
  await call(lead,'GET','files/revision/'+rev(classified),undefined,404);
  await call(lead,'GET',url,undefined,403);
  assert.equal((await get('reports/summary')).data.total,0);
});
