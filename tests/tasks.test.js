import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,createClient,PASSWORDS } from './helpers.js';
import { taskMigration } from '../lib/migrations/tasks.js';

test('задачи: границы модуля, жизненный цикл и согласованность', async t => {
  const ctx = await setup();
  t.after(()=>ctx.close());
  const { db,objectA,objectB,byTab } = ctx;
  async function login(tab,pw) {
    const client=createClient(ctx.base);
    assert.equal((await client.login(tab,pw)).status,200);
    return client;
  }
  const admin=await login('ADM900',PASSWORDS.admin), owner=await login('PTO900',PASSWORDS.pto);
  const engineer=await login('PTO901',PASSWORDS.pto2), worker=await login('M900',PASSWORDS.worker);
  async function call(client,method,path,body,expected=200) {
    const r=await client.request(method,'/api/'+path,{body});
    assert.equal(r.status,expected,method+' '+path+' '+r.text.slice(0,350));
    return r.data;
  }
  const get=(client,path)=>call(client,'GET',path);
  const create=(client,fields={})=>call(client,'POST','tasks',{title:'Проверить ведомость',objectId:objectA,assigneeId:byTab.PTO901,...fields});
  const first=(await create(owner,{dueDate:'2001-01-01',priority:'Высокий'})).data;
  const path='tasks/'+first.id;
  const change=(client,action,version,expected=200,reason)=>call(client,'POST',path+'/transitions',{action,version,reason},expected);
  const notices=async client=>(await get(client,'notifications')).data.filter(n=>n.link==='task:'+first.id);

  await t.test('кандидаты и создание: только активный инженер с назначением',async()=>{
    assert.deepEqual((await get(admin,'tasks/assignees?objectId='+objectB)).data.map(x=>x.id),[byTab.PTO900]);
    for (const [person,object] of [[byTab.ADM900,objectA],[byTab.M900,objectA],[byTab.PTO901,objectB]]) {
      await call(admin,'POST','tasks',{title:'Запрет',objectId:object,assigneeId:person},400);
    }
    db.prepare('UPDATE Сотрудник SET Заблокирован=1 WHERE ID_сотрудника=?').run(byTab.PTO901);
    await call(admin,'POST','tasks',{title:'Запрет',objectId:objectA,assigneeId:byTab.PTO901},400);
    db.prepare('UPDATE Сотрудник SET Заблокирован=0 WHERE ID_сотрудника=?').run(byTab.PTO901);
    await call(engineer,'GET','tasks/targets?objectId='+objectB,undefined,404);
    assert.equal((await notices(engineer)).length,1);
    await call(createClient(ctx.base),'GET','tasks',undefined,401);
    assert.equal((await owner.request('POST','/api/tasks',{csrf:false,body:{}})).status,403);
  });

  await t.test('монтажник и старший монтажник исключены из всех API задач, поиска и уведомлений',async()=>{
    const marker='ЗакрытаяДиспетчерская';
    await create(admin,{title:marker});
    const message=(await notices(engineer))[0];
    for (const role of ['Монтажник','Старший монтажник']) {
      db.prepare('UPDATE Сотрудник SET Должность=? WHERE ID_сотрудника=?').run(role,byTab.M900);
      for (const target of ['tasks','tasks?q='+encodeURIComponent(marker),'tasks/meta','tasks/summary',path,path+'/history',
        path+'/comments','tasks/assignees?objectId='+objectA,'tasks/targets?objectId='+objectA]) {
        await call(worker,'GET',target,undefined,403);
      }
      for (const [method,target] of [['POST','tasks'],['PATCH',path],['POST',path+'/comments'],['POST',path+'/transitions']]) {
        await call(worker,method,target,{},403);
      }
      assert.ok(!(await get(worker,'search?q='+encodeURIComponent(marker))).data.some(r=>r.kind==='task'));
      // Доставленное инженеру сообщение скрывается сразу после смены роли в той же сессии.
      db.prepare('UPDATE Сотрудник SET Должность=? WHERE ID_сотрудника=?').run(role,byTab.PTO901);
      assert.equal((await notices(engineer)).length,0);
      assert.equal((await get(engineer,'notifications/unread-count')).unread,0);
      await call(engineer,'POST','notifications/'+message.id+'/read',{},404);
      await call(engineer,'POST','notifications/read-all',{});
      await call(engineer,'GET',path,undefined,403);
      db.prepare("UPDATE Сотрудник SET Должность='Инженер ПТО' WHERE ID_сотрудника=?").run(byTab.PTO901);
      assert.ok((await notices(engineer)).every(n=>!n.read));
    }
    assert.ok((await get(engineer,'search?q='+encodeURIComponent(marker))).data.some(r=>r.kind==='task'));
  });

  await t.test('поиск, показатели, доступ чужого инженера и отзыв назначения',async()=>{
    const foreign=(await create(owner,{objectId:objectB,assigneeId:byTab.PTO900,title:'Другой объект'})).data;
    await call(engineer,'GET','tasks/'+foreign.id,undefined,404);
    const other=(await create(admin,{assigneeId:byTab.PTO900})).data;
    assert.equal((await get(engineer,'tasks/'+other.id)).data.permissions.edit,false);
    await call(engineer,'PATCH','tasks/'+other.id,{version:1,title:'Недоступно'},403);
    await call(engineer,'POST','tasks/'+other.id+'/comments',{text:'Чужая задача'},403);
    assert.equal((await get(engineer,'tasks?metric=overdue')).total,1);
    assert.equal((await get(engineer,'tasks/summary')).data.overdue,1);
    assert.equal((await get(engineer,'tasks?q='+encodeURIComponent('ДРУГОЙ ОБЪЕКТ'))).total,0);
    assert.ok((await get(engineer,'tasks?scope=mine')).data.every(x=>x.assigneeId===byTab.PTO901));
    assert.ok((await get(owner,'tasks?scope=created&sort=priority')).data.every(x=>x.creatorId===byTab.PTO900));
    const restore=[byTab.PTO901,objectA];
    db.prepare('DELETE FROM Доступ_объект WHERE ID_сотрудника=? AND ID_объекта=?').run(...restore);
    for (const suffix of ['','/comments','/history']) await call(engineer,'GET',path+suffix,undefined,404);
    assert.equal((await notices(engineer)).length,0);
    assert.equal((await get(engineer,'tasks/summary')).data.active,0);
    assert.equal((await get(engineer,'tasks')).total,0);
    assert.ok(!(await get(engineer,'search?q='+encodeURIComponent('ведомость'))).data.some(r=>r.kind==='task'));
    db.prepare('INSERT INTO Доступ_объект VALUES (?,?)').run(...restore);
  });

  await t.test('редактирование одной версии и независимые комментарии',async()=>{
    const updates=await Promise.all(['Обычный','Срочный'].map(priority=>owner.request('PATCH','/api/'+path,{body:{priority,version:1}})));
    assert.deepEqual(updates.map(r=>r.status).sort(),[200,409]);
    await call(owner,'PATCH',path,{version:2,status:'Выполнена'},400);
    await call(owner,'PATCH',path,{version:2,creatorId:byTab.ADM900},400);
    await call(engineer,'PATCH',path,{version:2,dueDate:'2027-01-01'},403);
    await Promise.all([owner,engineer].map((c,i)=>call(c,'POST',path+'/comments',{text:'Комментарий '+i})));
    const comments=(await get(owner,path+'/comments')).data;
    assert.equal(comments.length,2);
    assert.ok(comments.every(x=>x.author && x.createdAt));
  });

  await t.test('проверка, мотивированный возврат, приёмка и история',async()=>{
    await change(owner,'start',2,403);
    await change(engineer,'start',2);
    await change(engineer,'submit',3);
    await change(engineer,'accept',4,403);
    await change(owner,'return',4,400,' ');
    await change(owner,'return',4,200,'Уточнить раздел');
    await change(engineer,'submit',5);
    await change(admin,'accept',6);
    assert.equal((await get(owner,path)).data.status,'Выполнена');
    assert.equal((await get(owner,'tasks/summary')).data.overdue,0);
    assert.equal((await get(owner,'tasks?metric=done')).total,1);
    await call(owner,'POST',path+'/comments',{text:'Поздно'},403);
    const log=(await get(engineer,path+'/history')).data;
    assert.ok(log.some(e=>e.reason==='Уточнить раздел' && e.afterValue==='В работе'));
    assert.ok(log.some(e=>e.event==='Приоритет'));
    assert.ok((await notices(engineer)).some(n=>n.type==='Результат принят'));
    assert.ok((await notices(owner)).some(n=>n.type==='Задача на проверке'));
  });

  await t.test('переназначение, изменение срока и отмена',async()=>{
    const obj=(await create(admin)).data, p='tasks/'+obj.id;
    await call(engineer,'POST',p+'/transitions',{version:1,action:'start'});
    const updated=(await call(admin,'PATCH',p,{version:2,assigneeId:byTab.PTO900,dueDate:'2027-01-10'})).data;
    assert.equal(updated.status,'Новая');
    assert.equal(updated.assigneeId,byTab.PTO900);
    const received=(await get(owner,'notifications')).data.filter(n=>n.link==='task:'+obj.id);
    assert.deepEqual(received.map(n=>n.type).sort(),['Изменён срок','Изменён исполнитель'].sort());
    await call(engineer,'POST',p+'/transitions',{version:3,action:'start'},403);
    await call(admin,'POST',p+'/transitions',{version:3,action:'cancel'});
    assert.equal((await get(admin,p)).data.status,'Отменена');
  });

  await t.test('связанные записи и повторное применение миграции',async()=>{
    const doc=db.prepare('SELECT ID_документа AS id FROM Документ_ПТО WHERE ID_объекта=?').get(objectA).id;
    await call(admin,'POST','tasks',{title:'Чужая связь',objectId:objectB,assigneeId:byTab.PTO900,documentId:doc},404);
    const linked=(await create(owner,{documentId:doc})).data;
    db.prepare('UPDATE Документ_ПТО SET ID_объекта=? WHERE ID_документа=?').run(objectB,doc);
    const read=(await get(engineer,'tasks/'+linked.id)).data;
    assert.equal(read.documentId,null);
    assert.equal(read.version,2);
    assert.ok((await get(owner,'tasks/'+linked.id+'/history')).data.some(e=>e.event==='Снята связь'));
    const empty=(await call(admin,'POST','objects',{name:'Только задачи'})).data.id;
    db.prepare('INSERT INTO Доступ_объект VALUES (?,?)').run(byTab.PTO900,empty);
    const isolated=(await create(admin,{objectId:empty,assigneeId:byTab.PTO900})).data;
    await call(admin,'DELETE','objects/'+empty,undefined,409);
    taskMigration.up(db);
    assert.equal((await get(admin,'tasks/'+isolated.id)).data.version,1);
  });

  await t.test('ошибка обязательного уведомления откатывает задачу и историю',async()=>{
    const before=db.prepare('SELECT count(*) AS n FROM Задача').get();
    const log=db.prepare('SELECT count(*) AS n FROM История_задачи').get();
    db.exec("CREATE TEMP TRIGGER fail_task_notice BEFORE INSERT ON Уведомление WHEN NEW.Ссылка LIKE 'task:%' BEGIN SELECT RAISE(ABORT,'test notice failure'); END");
    try { await call(admin,'POST','tasks',{title:'Откат',objectId:objectA,assigneeId:byTab.PTO901},500); }
    finally { db.exec('DROP TRIGGER fail_task_notice'); }
    assert.deepEqual(db.prepare('SELECT count(*) AS n FROM Задача').get(),before);
    assert.deepEqual(db.prepare('SELECT count(*) AS n FROM История_задачи').get(),log);
  });
});
