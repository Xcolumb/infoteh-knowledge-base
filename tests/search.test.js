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

  await t.test('PTO-05: текст и позиции подсветки сохраняют исходную разметку и границы объекта', async () => {
    const body = '🧱 <mark>Кабель</mark> & <b>лоток</b>';
    const title = 'Проект <i>А</i>';
    await client.login('PTO900', PASSWORDS.pto);
    for (const objectId of [ctx.objectA, ctx.objectB]) {
      const response = await client.request('POST', '/api/pto', {
        multipart: true, body: docForm({ objectId, title, content: body })
      });
      assert.equal(response.status, 200);
    }
    await client.login('PTO901', PASSWORDS.pto2);
    try {
      for (const engine of ['fts5', 'like']) {
        db.__ftsUnavailable = engine === 'like';
        const response = await client.request('GET', '/api/search?q=' + encodeURIComponent('Кабель'));
        assert.equal(response.data.engine, engine);
        const rows = response.data.data.filter((item) => item.title === title);
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.equal(row.objectId, ctx.objectA);
        assert.equal(row.fragment, body);
        assert.deepEqual(row.highlights.map(([start, end]) => row.fragment.slice(start, end)), ['Кабель']);
      }
    } finally {
      db.__ftsUnavailable = false;
    }
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
