import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup,docForm,pdfFile,PASSWORDS} from './helpers.js';
import {recoverFiles} from '../lib/file-transaction.js';

test('операции с файлами переживают откат, повтор и отложенное удаление',async t=>{
  const ctx=await setup();
  t.after(()=>ctx.close());
  await ctx.client.login('ADM900',PASSWORDS.admin);
  const db=ctx.db, uploads=path.join(ctx.dir,'uploads');
  const send=(method,url,key,content='версия')=>ctx.client.request(method,url,{multipart:true,
    headers:{'Idempotency-Key':key},body:docForm({objectId:ctx.objectA,file:pdfFile('акт.pdf',content)})});
  const files=()=>fs.readdirSync(uploads,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>e.name);
  const before=db.prepare('SELECT count(*) FROM Документ_ПТО').pluck().get();
  db.exec("CREATE TEMP TRIGGER fail_history BEFORE INSERT ON История_ПТО BEGIN SELECT RAISE(ABORT,'history failure'); END");
  assert.equal((await send('POST','/api/pto','create')).status,500);
  assert.equal(db.prepare('SELECT count(*) FROM Документ_ПТО').pluck().get(),before);
  assert.deepEqual(files(),[]);
  db.exec('DROP TRIGGER fail_history');
  const created=await send('POST','/api/pto','create');
  assert.equal(created.status,200,created.text);
  const id=created.data.data.id,url='/api/pto/'+id;
  assert.equal((await send('POST','/api/pto','create')).data.data.id,id);
  const original=files()[0];
  db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON Аудит WHEN NEW.Сущность='document' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.equal((await send('PUT',url,'update','новая')).status,500);
  assert.deepEqual(files(),[original]);
  assert.equal((await ctx.client.request('DELETE',url)).status,500);
  assert.ok(fs.existsSync(path.join(uploads,original)));
  db.exec('DROP TRIGGER fail_audit');
  for(let i=0;i<2;i++) assert.equal((await send('PUT',url,'update','новая')).data.data.version,2);
  assert.equal((await send('PUT',url,'update','изменено')).status,409);
  assert.equal(files().length,2);
  const rename=fs.renameSync;
  try {
    fs.renameSync=()=>{throw Error('test rename failure')};
    assert.equal((await send('PUT',url,'third')).status,500);
  } finally {fs.renameSync=rename;}
  assert.equal(files().length,2);
  const rm=fs.rmSync;
  try {
    fs.rmSync=(name,...args)=>{if(name===path.join(uploads,original)) throw Error('test busy file'); return rm(name,...args);};
    assert.equal((await ctx.client.request('DELETE',url)).status,200);
  } finally {fs.rmSync=rm;}
  assert.deepEqual(files(),[original]);
  recoverFiles(db);
  assert.deepEqual(files(),[]);
});
