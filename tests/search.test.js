import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORDS, docForm } from './helpers.js';

test('полнотекстовый поиск с учётом прав', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client, db } = ctx;

  const unique = 'УникальноеСлово123';

  await client.login('PTO900', PASSWORDS.pto);

  await t.test('статус поиска сообщает движок', async () => {
    const response = await client.request('GET', '/api/search/status');
    assert.equal(response.status, 200);
    assert.ok(['fts5', 'like'].includes(response.data.engine));
  });

  await t.test('документ находится по названию', async () => {
    const created = await client.request('POST', '/api/pto', {
      multipart: true,
      body: docForm({ objectId: ctx.objectB, title: `Документ ${unique}` })
    });
    assert.equal(created.status, 200);

    const response = await client.request('GET', `/api/search?q=${encodeURIComponent(unique)}`);
    assert.equal(response.status, 200);
    assert.ok(response.data.data.some((item) => item.kind === 'document' && item.title.includes(unique)));
  });

  await t.test('пользователь без доступа к объекту не находит документ', async () => {
    await client.login('PTO901', PASSWORDS.pto2);
    const response = await client.request('GET', `/api/search?q=${encodeURIComponent(unique)}`);
    assert.equal(response.status, 200);
    assert.equal(response.data.data.length, 0);
  });

  await t.test('слишком короткий запрос не выполняется', async () => {
    const response = await client.request('GET', '/api/search?q=а');
    assert.equal(response.status, 200);
    assert.equal(response.data.data.length, 0);
  });

  await t.test('индекс обновляется после изменения документа', async () => {
    await client.login('PTO900', PASSWORDS.pto);
    const row = db.prepare("SELECT \"ID_документа\" as id FROM \"Документ_ПТО\" WHERE \"Название\" LIKE ?").get(`%${unique}%`);

    const updateForm = docForm({ objectId: ctx.objectB, title: `Переименованный ${unique}` });
    await client.request('PUT', `/api/pto/${row.id}`, { multipart: true, body: updateForm });

    const response = await client.request('GET', `/api/search?q=${encodeURIComponent('Переименованный')}`);
    assert.ok(response.data.data.some((item) => item.title.includes('Переименованный')));
  });
});
