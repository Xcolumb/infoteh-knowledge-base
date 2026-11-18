import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { setup, PASSWORDS, pdfFile, docForm } from './helpers.js';

test('доступ к файлам и объектам', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client, db, dir } = ctx;

  let documentId = null;
  let fileId = null;

  await t.test('инженер ПТО создаёт документ с файлом в своём объекте', async () => {
    await client.login('PTO900', PASSWORDS.pto);
    const response = await client.request('POST', '/api/pto', {
      multipart: true,
      body: docForm({ objectId: ctx.objectA, title: 'Документ с файлом', file: pdfFile('акт.pdf') })
    });
    assert.equal(response.status, 200);
    documentId = response.data.data.id;

    const detail = await client.request('GET', `/api/pto/${documentId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.revisions.length, 1);
    assert.ok(detail.data.data.file.startsWith('/api/files/document/'));
  });

  await t.test('файл доступен авторизованному пользователю с правами (200)', async () => {
    const response = await client.request('GET', `/api/files/document/${documentId}`);
    assert.equal(response.status, 200);
    assert.equal(response.text, 'PDF-TEST-CONTENT');
  });

  await t.test('анонимный запрос файла получает 401', async () => {
    const response = await fetch(`${ctx.base}/api/files/document/${documentId}`, { redirect: 'manual' });
    assert.equal(response.status, 401);
  });

  await t.test('инженер без доступа к объекту получает 403 на документ и файл', async () => {
    // Документ в объекте Б, к которому у PTO901 доступа нет.
    await client.login('PTO900', PASSWORDS.pto);
    const created = await client.request('POST', '/api/pto', {
      multipart: true,
      body: docForm({ objectId: ctx.objectB, title: 'Документ объекта Б', file: pdfFile('б-object.pdf') })
    });
    assert.equal(created.status, 200);
    const docB = created.data.data.id;

    await client.login('PTO901', PASSWORDS.pto2);
    const document = await client.request('GET', `/api/pto/${docB}`);
    assert.equal(document.status, 403);

    const file = await client.request('GET', `/api/files/document/${docB}`);
    assert.equal(file.status, 403);
  });

  await t.test('список документов фильтруется по доступным объектам', async () => {
    await client.login('PTO901', PASSWORDS.pto2);
    const list = await client.request('GET', '/api/pto');
    assert.equal(list.status, 200);
    assert.ok(list.data.data.length >= 1);
    assert.ok(list.data.data.every((doc) => doc.objectId === ctx.objectA));
  });

  await t.test('прямой доступ к uploads закрыт', async () => {
    const response = await fetch(`${ctx.base}/uploads/anything.pdf`, { redirect: 'manual' });
    assert.equal(response.status, 404);
  });

  await t.test('path traversal не выходит за пределы uploads', async () => {
    const secretPath = path.join(dir, 'secret.txt');
    fs.writeFileSync(secretPath, 'SECRET');

    const doc = db.prepare('SELECT "ID_документа" as id FROM "Документ_ПТО" LIMIT 1').get();
    db.prepare('UPDATE "Документ_ПТО" SET "Файл" = ? WHERE "ID_документа" = ?').run('uploads/../../secret.txt', doc.id);

    await client.login('PTO900', PASSWORDS.pto);
    const response = await client.request('GET', `/api/files/document/${doc.id}`);
    assert.equal(response.status, 404);
  });

  await t.test('загрузка файла недопустимого типа отклоняется', async () => {
    await client.login('PTO900', PASSWORDS.pto);
    const badFile = new File([Buffer.from('<html></html>')], 'virus.html', { type: 'text/html' });
    const response = await client.request('POST', '/api/pto', {
      multipart: true,
      body: docForm({ objectId: ctx.objectA, title: 'Плохой файл', file: badFile })
    });
    assert.equal(response.status, 400);
  });

  await t.test('смена файла создаёт новую редакцию и не удаляет прежний файл', async () => {
    await client.login('PTO900', PASSWORDS.pto);
    const before = db.prepare('SELECT "Файл" as file FROM "Документ_ПТО" WHERE "ID_документа" = ?').get(documentId);

    const updateForm = docForm({ objectId: ctx.objectA, title: 'Документ с файлом', file: pdfFile('акт-v2.pdf', 'PDF-V2') });
    const response = await client.request('PUT', `/api/pto/${documentId}`, { multipart: true, body: updateForm });
    assert.equal(response.status, 200);

    const detail = await client.request('GET', `/api/pto/${documentId}`);
    assert.equal(detail.data.data.version, 2);
    assert.equal(detail.data.data.revisions.length, 2);

    const firstRevision = detail.data.data.revisions.find((revision) => revision.version === 1);
    assert.ok(firstRevision.file);
    const firstFile = await client.request('GET', firstRevision.file);
    assert.equal(firstFile.status, 200);
    assert.equal(firstFile.text, 'PDF-TEST-CONTENT');

    const oldAbsolute = path.join(ctx.dir, 'uploads', path.basename(before.file));
    assert.ok(fs.existsSync(oldAbsolute), 'старый файл должен остаться на диске');
  });

  await t.test('редакции другого объекта недоступны', async () => {
    const docB = db.prepare('SELECT "ID_документа" as id FROM "Документ_ПТО" WHERE "Название" = ? LIMIT 1').get('Документ объекта Б');
    await client.login('PTO900', PASSWORDS.pto);

    const updateForm = docForm({ objectId: ctx.objectB, title: 'Документ объекта Б', file: pdfFile('б-object-v2.pdf', 'PDF-B2') });
    const update = await client.request('PUT', `/api/pto/${docB.id}`, { multipart: true, body: updateForm });
    assert.equal(update.status, 200);

    const revision = db.prepare('SELECT "ID_редакции" as id FROM "Редакция_ПТО" WHERE "ID_документа" = ? ORDER BY "Версия" DESC LIMIT 1').get(docB.id);
    void fileId;

    await client.login('PTO901', PASSWORDS.pto2);
    const response = await client.request('GET', `/api/files/revision/${revision.id}`);
    assert.equal(response.status, 403);
  });

  await t.test('администратор видит документы всех объектов', async () => {
    await client.login('ADM900', PASSWORDS.admin);
    const list = await client.request('GET', '/api/pto');
    const objectIds = new Set(list.data.data.map((doc) => doc.objectId));
    assert.ok(objectIds.has(ctx.objectA));
    assert.ok(objectIds.has(ctx.objectB));
  });
});
