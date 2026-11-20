import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, createClient, PASSWORDS, docForm, pdfFile } from './helpers.js';

test('объектные права ПТО на изолированном стенде', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { db, objectA, objectB, byTab } = ctx;

  async function login(tab, password) {
    const client = createClient(ctx.base);
    assert.equal((await client.login(tab, password)).status, 200);
    return client;
  }

  async function call(client, method, resource, body, expected = 200) {
    const response = await client.request(method, '/api/' + resource, { body, multipart: body instanceof FormData });
    assert.equal(response.status, expected, method + ' ' + resource + ': ' + response.text.slice(0, 160));
    return response;
  }

  async function create(client, resource, body) {
    return (await call(client, 'POST', resource, body)).data.data.id;
  }

  async function get(client, resource) {
    return (await call(client, 'GET', resource)).data.data;
  }

  const admin = await login('ADM900', PASSWORDS.admin);
  const a = await login('PTO901', PASSWORDS.pto2);
  const b = await login('PTO900', PASSWORDS.pto);
  const worker = await login('M900', PASSWORDS.worker);
  const assign = (id, objectIds) => call(admin, 'PUT', 'sotrudniki/' + id + '/access', { objectIds });
  await assign(byTab.PTO900, [objectB]);
  await assign(byTab.M900, [objectA]);
  const freeId = await create(admin, 'sotrudniki', { fullName: 'Тестовый инженер', tabNumber: 'T902',
    role: 'Инженер ПТО', password: PASSWORDS.pto2, objectIds: [] });
  const free = await login('T902', PASSWORDS.pto2);

  const titleA = 'Контроль Альфа';
  const titleB = 'Контроль Бета';
  const titleNull = 'Контроль без привязки';
  const doc = (client, objectId, title) => create(client, 'pto', docForm({ objectId, title, file: pdfFile() }));
  const docA = await doc(a, objectA, titleA);
  const docB = await doc(b, objectB, titleB);
  const loose = await doc(admin, null, titleNull);
  const setA = await create(a, 'completeness', { name: 'Комплект A', objectId: objectA });
  const setB = await create(b, 'completeness', { name: 'Комплект B', objectId: objectB });
  const setNull = await create(admin, 'completeness', { name: 'Без объекта' });
  const remarkA = await create(a, 'remarks', { objectId: objectA, description: 'Замечание A', documentId: docA, dueDate: '2000-01-01' });
  const remarkB = await create(b, 'remarks', { objectId: objectB, description: 'Замечание B', documentId: docB, dueDate: '2000-01-01' });
  const remarkNull = await create(admin, 'remarks', { description: 'Прочее' });
  const reqA = await create(a, 'completeness/' + setA + '/requirements', { name: 'Позиция A' });
  const link = 'completeness/requirements/' + reqA + '/documents';
  await call(a, 'POST', link, { documentId: docA });

  await t.test('назначения и 404 до проверки зависимостей; создание пустого объекта', async () => {
    assert.deepEqual((await get(a, 'objects')).map(o => o.id), [objectA]);
    assert.deepEqual((await get(b, 'objects')).map(o => o.id), [objectB]);
    assert.deepEqual(await get(free, 'objects'), []);
    const previous = db.prepare('SELECT * FROM Объект WHERE ID_объекта = ?').get(objectB);
    for (const method of ['PUT', 'DELETE']) {
      const body = method === 'PUT' ? { name: 'Проверка' } : undefined;
      const foreign = await call(a, method, 'objects/' + objectB, body, 404);
      const missing = await call(a, method, 'objects/999999', body, 404);
      assert.deepEqual([foreign.data.code, foreign.data.error], [missing.data.code, missing.data.error]);
    }
    assert.deepEqual(db.prepare('SELECT * FROM Объект WHERE ID_объекта = ?').get(objectB), previous);
    const id = await create(free, 'objects', { name: 'Новый объект' });
    assert.deepEqual((await get(free, 'objects')).map(o => o.id), [id]);
    await call(free, 'PUT', 'objects/' + id, { name: 'Переименован' });
    await call(free, 'DELETE', 'objects/' + id);
    assert.deepEqual(await get(free, 'objects'), []);
  });

  await t.test('даже неактивный комплект запрещает удаление объекта обеим ролям', async () => {
    const id = await create(a, 'objects', { name: 'Есть только комплект' });
    const set = await create(a, 'completeness', { name: 'Архив', objectId: id });
    await call(a, 'PUT', 'completeness/' + set, { name: 'Архив', objectId: id, active: false });
    for (const client of [a, admin]) await call(client, 'DELETE', 'objects/' + id, undefined, 409);
    assert.equal((await get(a, 'completeness/' + set)).objectId, id);
    await call(admin, 'DELETE', 'completeness/' + set);
    await call(admin, 'DELETE', 'objects/' + id);
  });

  await t.test('роль, авторство, блокировка и завершённая сессия', async () => {
    await call(worker, 'POST', 'objects', { name: 'Запрещено' }, 403);
    assert.equal((await get(worker, 'pto/' + docA)).id, docA);
    await call(worker, 'POST', 'remarks/' + remarkA + '/comments', { text: 'Комментарий исполнителя' });
    db.prepare("UPDATE Сотрудник SET Должность = 'Старший монтажник' WHERE ID_сотрудника = ?").run(byTab.M900);
    await call(worker, 'PUT', 'objects/' + objectA, { name: 'Запрещено' }, 403);
    assert.equal((await get(worker, 'pto/' + docA)).id, docA);
    await assign(byTab.PTO900, [objectA, objectB]);
    await call(b, 'DELETE', 'pto/' + docA, undefined, 403);
    await call(b, 'DELETE', 'remarks/' + remarkA, undefined, 403);
    await assign(byTab.PTO900, [objectB]);
    await call(admin, 'PUT', 'sotrudniki/' + freeId + '/block', { blocked: true });
    const blocked = await free.request('POST', '/api/objects', { body: { name: 'Закрытая сессия' }, csrf: false });
    assert.equal(blocked.status, 401);
    await call(createClient(ctx.base), 'POST', 'objects', { name: 'Нет сессии' }, 401);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Объект WHERE Название IN (?, ?)').get('Закрытая сессия', 'Нет сессии').n, 0);
    await call(admin, 'PUT', 'sotrudniki/' + freeId + '/block', { blocked: false });
    assert.equal((await free.login('T902', PASSWORDS.pto2)).status, 200);
  });

  await t.test('карточки, файлы, просмотр редакций, NULL и отсутствие назначений', async () => {
    for (const [id, owner] of [[docB, b], [loose, admin]]) {
      const card = await get(owner, 'pto/' + id);
      const rev = card.revisions[0].id;
      for (const resource of ['pto/' + id, 'files/document/' + id, 'preview/document/' + id,
        'files/revision/' + rev, 'preview/revision/' + rev, 'preview/revision/' + rev + '/content']) {
        await call(a, 'GET', resource, undefined, 404);
        await call(free, 'GET', resource, undefined, 404);
      }
      await call(owner, 'GET', 'files/revision/' + rev);
    }
    for (const [route, id] of [['remarks', remarkNull], ['completeness', setNull]]) {
      assert.equal((await get(admin, route + '/' + id)).objectId, null);
      for (const client of [a, free]) {
        await call(client, 'GET', route + '/' + id, undefined, 404);
        assert.ok(!(await get(client, route)).some(row => row.id === id));
      }
    }
    await call(a, 'POST', 'pto', docForm({ title: 'Нужен объект' }), 404);
    await call(a, 'POST', 'remarks', { description: 'Нужен объект' }, 404);
    await call(a, 'POST', 'completeness', { name: 'Нужен объект' }, 404);
    assert.deepEqual(await get(free, 'pto'), []);
  });

  await t.test('замечание, вложение, просмотр и выгрузка за границей объекта', async () => {
    const form = new FormData();
    form.append('file', pdfFile());
    await call(b, 'POST', 'remarks/' + remarkB + '/attachments', form);
    const detail = await get(b, 'remarks/' + remarkB);
    const attachment = detail.attachments[0].id;
    await call(b, 'GET', 'files/remark/' + attachment);
    for (const route of ['remarks/' + remarkB, 'files/remark/' + attachment,
      'preview/remark/' + attachment, 'preview/remark/' + attachment + '/content']) {
      await call(a, 'GET', route, undefined, 404);
    }
    assert.deepEqual((await get(a, 'remarks')).map(row => row.id), [remarkA]);
    assert.deepEqual((await get(b, 'completeness')).map(row => row.id), [setB]);
    assert.deepEqual(await get(free, 'completeness'), []);
  });

  await t.test('реестр, FTS, резервный LIKE и число доступных индексированных строк', async () => {
    for (const fallback of [false, true]) {
      db.__ftsUnavailable = fallback;
      try {
        for (const [client, titles] of [[a, [titleA]], [b, [titleB]], [free, []], [admin, [titleA, titleB, titleNull]]]) {
          const hits = await call(client, 'GET', 'search?q=' + encodeURIComponent('Контроль'));
          assert.equal(hits.data.engine, fallback ? 'like' : 'fts5');
          assert.deepEqual(hits.data.data.map(x => x.title).sort(), [...titles].sort());
          if (!fallback) {
            const status = await call(client, 'GET', 'search/status');
            assert.equal(status.data.indexed, titles.length);
          }
        }
      } finally { db.__ftsUnavailable = false; }
    }
    const rows = await get(a, 'pto');
    assert.ok(rows.some(row => row.id === docA));
    assert.ok(rows.every(row => row.objectId === objectA));
  });

  await t.test('сводные показатели, сроки и CSV соответствуют назначению', async () => {
    for (const [client, docs, remarks, sets] of [[a, 2, 1, 1], [b, 2, 1, 1], [free, 0, 0, 0], [admin, 5, 3, 3]]) {
      const summary = await get(client, 'reports/summary');
      assert.deepEqual([summary.total, summary.remarksOpen, summary.setsTotal], [docs, remarks, sets]);
    }
    assert.equal((await get(a, 'reports/summary')).remarksOverdue, 1);
    const outside = await get(a, 'reports/summary?objectId=' + objectB);
    assert.deepEqual([outside.total, outside.remarksOpen, outside.remarksOverdue, outside.setsTotal], [0, 0, 0, 0]);
    for (const resource of ['reports/documents.csv', 'pto/export.csv', 'reports/remarks.csv']) {
      const own = (await call(a, 'GET', resource)).text;
      assert.ok(own.includes(titleA));
      assert.ok(!own.includes(titleB) && !own.includes(titleNull));
      assert.equal((await call(free, 'GET', resource)).text.trim().split('\n').length, 1);
      assert.equal((await call(a, 'GET', resource + '?objectId=' + objectB)).text.trim().split('\n').length, 1);
    }
    await call(a, 'GET', 'completeness/' + setB + '/missing.csv', undefined, 404);
  });

  await t.test('изменение связей и атомарный отказ переноса', async () => {
    await call(a, 'POST', link, { documentId: docB }, 404);
    await call(admin, 'POST', link, { documentId: loose }, 409);
    await call(admin, 'POST', link, { documentId: docB }, 409);
    await call(a, 'POST', 'remarks', { objectId: objectA, documentId: docB, description: 'Несовместимо' }, 404);
    await call(admin, 'PUT', 'remarks/' + remarkA, { objectId: objectA, documentId: docB, description: 'Несовместимо' }, 409);
    await call(admin, 'PUT', 'remarks/' + remarkA, { objectId: objectB, description: 'Несовместимо' }, 409);
    const before = await get(admin, 'pto/' + docA);
    const filesBefore = fs.readdirSync(path.join(ctx.dir, 'uploads')).sort();
    const move = () => docForm({ objectId: objectB, title: 'Перенос', file: pdfFile('move.pdf') });
    await call(a, 'PUT', 'pto/' + docA, move(), 404);
    await call(admin, 'PUT', 'pto/' + docA, move(), 409);
    assert.deepEqual(await get(admin, 'pto/' + docA), before);
    assert.deepEqual(fs.readdirSync(path.join(ctx.dir, 'uploads')).sort(), filesBefore);
    await call(admin, 'PUT', 'completeness/' + setA, { objectId: objectB, name: 'Перенос' }, 409);
    assert.equal((await get(admin, 'completeness/' + setA)).objectId, objectA);
    assert.equal((await get(admin, 'remarks/' + remarkA)).documentId, docA);
    // Ошибка после UPDATE должна откатить и перенос свободной карточки, и архивацию сообщений.
    const independent = await doc(a, objectA, 'До ошибки');
    await call(a, 'PATCH', 'pto/' + independent + '/status', { status: 'На проверке' });
    const original = await get(a, 'pto/' + independent);
    const note = (await get(a, 'notifications')).find(n => n.link === 'pto:' + independent);
    const invalid = docForm({ objectId: objectB, title: 'После ошибки', status: 'Утверждён' });
    invalid.append('comment', 'я'.repeat(501));
    await call(admin, 'PUT', 'pto/' + independent, invalid, 400);
    assert.deepEqual(await get(a, 'pto/' + independent), original);
    assert.ok((await get(a, 'notifications')).some(n => n.id === note.id));
    await call(admin, 'PUT', 'remarks/' + remarkA, { objectId: objectB, documentId: docB, description: 'Перенесено' });
    await call(a, 'GET', 'remarks/' + remarkA, undefined, 404);
    assert.equal((await get(b, 'remarks/' + remarkA)).documentId, docB);
    await call(admin, 'PUT', 'completeness/' + setB, { objectId: objectA, name: 'Согласованный перенос' });
    await call(b, 'GET', 'completeness/' + setB, undefined, 404);
  });

  await t.test('старые несовместимые связи не раскрывают метаданные и не засчитывают комплект', async () => {
    // Моделируем архивные записи только в тестовой базе.
    db.prepare('UPDATE Документ_комплекта SET ID_документа = ? WHERE ID_требования = ?').run(docB, reqA);
    db.prepare('UPDATE Замечание SET ID_объекта = ? WHERE ID_замечания = ?').run(objectA, remarkB);
    const z = await get(a, 'remarks/' + remarkB);
    assert.equal(z.documentTitle, null);
    assert.equal(z.documentId, null);
    const set = await get(a, 'completeness/' + setA);
    assert.deepEqual(set.requirements[0].documents, []);
    assert.equal(set.stats.missing, 1);
    assert.equal((await get(a, 'reports/summary')).setsComplete, 0);
    assert.ok(!(await call(a, 'GET', 'reports/remarks.csv')).text.includes(titleB));
    assert.ok(!(await call(a, 'GET', 'completeness/' + setA + '/missing.csv')).text.includes(titleB));
  });

  await t.test('уведомления при отправке, чтении, отзыве назначения и переносе', async () => {
    const id = await doc(a, objectA, 'Уведомление A');
    const source = 'pto:' + id;
    await call(a, 'PATCH', 'pto/' + id + '/status', { status: 'На проверке', comment: 'Первоначальный комментарий' });
    // Одна историческая запись с известным источником и одна осиротевшая.
    const legacy = db.prepare(`INSERT INTO Уведомление
      (ID_сотрудника, Тип, Текст, Ссылка, Ключ, Создано) VALUES (?, 'Прежнее событие', 'Исторический текст', ?, ?, datetime('now'))`);
    legacy.run(byTab.PTO901, source, 'legacy-with-source');
    legacy.run(byTab.PTO901, 'pto:999999', 'legacy-without-source');
    const visible = await get(a, 'notifications');
    assert.ok(visible.some(n => n.type === 'Прежнее событие' && n.link === source));
    assert.ok(!JSON.stringify(visible).includes('Исторический текст'));
    assert.ok(!visible.some(n => n.link === 'pto:999999'));
    const own = (await get(a, 'notifications')).filter(n => n.type !== 'Прежнее событие').find(n => n.link === source);
    assert.ok(own.text.includes('Первоначальный комментарий'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM Уведомление WHERE Ссылка = ? AND ID_сотрудника = ?').get(source, byTab.PTO900).n, 0);
    await call(b, 'POST', 'notifications/' + own.id + '/read', {}, 404);
    await assign(byTab.PTO901, []);
    assert.deepEqual(await get(a, 'notifications'), []);
    assert.equal((await call(a, 'GET', 'notifications/unread-count')).data.unread, 0);
    await call(a, 'POST', 'notifications/' + own.id + '/read', {}, 404);
    await call(a, 'POST', 'notifications/read-all', {});
    assert.equal(db.prepare('SELECT Прочитано FROM Уведомление WHERE ID_уведомления = ?').get(own.id).Прочитано, 0);
    assert.deepEqual((await call(a, 'POST', 'notifications/scan', {})).data.created, { docs: 0, remarks: 0 });
    await assign(byTab.PTO901, [objectA]);
    await call(admin, 'PUT', 'pto/' + id, docForm({ objectId: objectB, title: 'Новая карточка B', status: 'Утверждён' }));
    assert.ok(!(await get(a, 'notifications')).some(n => n.link === source));
    const after = (await get(b, 'notifications')).filter(n => n.link === source);
    assert.ok(after.length > 0 && after.every(n => n.text.includes('Новая карточка B')));
    assert.ok(!JSON.stringify(after).includes('Первоначальный комментарий'));
    assert.ok(!JSON.stringify(after).includes('На проверке'));
    assert.ok(!(await get(admin, 'notifications')).some(n => n.text.includes('Первоначальный комментарий')));
  });

  await t.test('импорт проверяет область доступа до поиска дубликатов', async () => {
    const row = { type: 'ППР', title: titleNull };
    for (const object of ['', 'Объект Б (тест)', 'Несуществующий']) {
      const result = await call(a, 'POST', 'import/commit', { rows: [{ ...row, object }] }, 400);
      assert.equal(result.data.details[0].duplicate, false);
      if (object) assert.deepEqual(result.data.details[0].errors, ['объект не найден']);
    }
    const report = await call(a, 'POST', 'import/commit', { rows: [{ ...row, title: 'Штатный импорт', object: 'Объект А (тест)' }] });
    assert.equal(report.data.created, 1);
  });
});
