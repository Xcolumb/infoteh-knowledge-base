import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORDS, docForm } from './helpers.js';

test('реестр ПТО: статусы, версии, экспорт, импорт', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client, base } = ctx;

  await client.login('PTO900', PASSWORDS.pto);

  let documentId = null;

  await t.test('создание документа', async () => {
    const response = await client.request('POST', '/api/pto', {
      multipart: true,
      body: docForm({ objectId: ctx.objectA, title: 'ППР для проверки', dueDate: '2026-12-31', responsible: 'Петров Пётр Петрович' })
    });
    assert.equal(response.status, 200);
    documentId = response.data.data.id;
  });

  await t.test('смена статуса фиксируется в истории', async () => {
    const response = await client.request('PATCH', `/api/pto/${documentId}/status`, {
      body: { status: 'На проверке', comment: 'Передано на проверку' }
    });
    assert.equal(response.status, 200);

    const detail = await client.request('GET', `/api/pto/${documentId}`);
    const changes = detail.data.data.history.filter((entry) => entry.action === 'Смена статуса');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].statusFrom, 'Черновик');
    assert.equal(changes[0].statusTo, 'На проверке');
  });

  await t.test('повторная смена на тот же статус отклоняется', async () => {
    const response = await client.request('PATCH', `/api/pto/${documentId}/status`, { body: { status: 'На проверке' } });
    assert.equal(response.status, 400);
  });

  await t.test('CSV-экспорт содержит документ', async () => {
    const response = await client.request('GET', '/api/pto/export.csv');
    assert.equal(response.status, 200);
    assert.ok(response.text.includes('ППР для проверки'));
    assert.ok(response.text.includes('Тип'));
  });

  await t.test('импорт с ошибкой отменяется целиком', async () => {
    const invalidRows = [
      { type: 'ППР', title: 'Новый документ', object: 'Объект А (тест)', status: 'Черновик', dueDate: '2026-12-10' },
      { type: 'ППР', title: '', object: 'Несуществующий объект', status: 'Черновик', dueDate: '2026-12-10' }
    ];

    const response = await client.request('POST', '/api/import/commit', { body: { rows: invalidRows } });
    assert.equal(response.status, 400);

    const list = await client.request('GET', '/api/pto?q=Новый документ');
    assert.equal(list.data.data.length, 0, 'при ошибке не должно быть частичного импорта');
  });

  await t.test('корректный импорт создаёт документы', async () => {
    const rows = [
      { type: 'ППР', title: 'Импортированный документ 1', object: 'Объект А (тест)', status: 'Черновик', dueDate: '2026-12-10' },
      { type: 'Входной контроль', title: 'Импортированный документ 2', object: 'Объект А (тест)', status: 'На проверке', dueDate: '2026-12-11' }
    ];

    const response = await client.request('POST', '/api/import/commit', { body: { rows } });
    assert.equal(response.status, 200);
    assert.equal(response.data.created, 2);
  });

  await t.test('экспорт реестра доступен только авторизованным', async () => {
    const anonymous = await fetch(`${base}/api/pto/export.csv`, { redirect: 'manual' });
    assert.equal(anonymous.status, 401);
  });
});
