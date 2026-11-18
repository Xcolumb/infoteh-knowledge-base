import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORDS, docForm } from './helpers.js';

test('комплектность ИД', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client } = ctx;

  await client.login('PTO900', PASSWORDS.pto);

  let setId;
  let requirementId;
  let documentId;

  await t.test('создание комплекта и требования', async () => {
    const setResponse = await client.request('POST', '/api/completeness', {
      body: { name: 'Комплект ИД (тест)', objectId: ctx.objectA, responsible: 'Петров Пётр Петрович' }
    });
    assert.equal(setResponse.status, 200);
    setId = setResponse.data.data.id;

    const requirement = await client.request('POST', `/api/completeness/${setId}/requirements`, {
      body: { name: 'Акты скрытых работ', type: 'Акт скрытых работ', required: true }
    });
    assert.equal(requirement.status, 200);
    requirementId = requirement.data.data.id;
  });

  await t.test('позиция без документа считается отсутствующей', async () => {
    const detail = await client.request('GET', `/api/completeness/${setId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.stats.missing, 1);
    assert.equal(detail.data.data.requirements[0].state, 'Отсутствует');
  });

  await t.test('привязка документа меняет состояние', async () => {
    const doc = await client.request('POST', '/api/pto', {
      multipart: true,
      body: docForm({ objectId: ctx.objectA, title: 'Акт скрытых работ (тест)' })
    });
    documentId = doc.data.data.id;

    const link = await client.request('POST', `/api/completeness/requirements/${requirementId}/documents`, {
      body: { documentId }
    });
    assert.equal(link.status, 200);

    const detail = await client.request('GET', `/api/completeness/${setId}`);
    assert.equal(detail.data.data.requirements[0].documents.length, 1);
    assert.equal(detail.data.data.stats.missing, 0);
  });

  await t.test('документ другого объекта нельзя привязать', async () => {
    const otherDoc = ctx.db.prepare('SELECT "ID_документа" as id FROM "Документ_ПТО" WHERE "ID_объекта" = ? LIMIT 1').get(ctx.objectB);
    const response = await client.request('POST', `/api/completeness/requirements/${requirementId}/documents`, {
      body: { documentId: otherDoc.id }
    });
    assert.equal(response.status, 409);
  });

  await t.test('отчёт о недостающих позициях отдаёт CSV', async () => {
    const response = await client.request('GET', `/api/completeness/${setId}/missing.csv`);
    assert.equal(response.status, 200);
    assert.ok(response.text.includes('Требование'));
  });
});

test('замечания и предписания', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client, db } = ctx;

  await client.login('PTO900', PASSWORDS.pto);

  let remarkId;

  await t.test('создание замечания', async () => {
    const response = await client.request('POST', '/api/remarks', {
      body: {
        objectId: ctx.objectA,
        description: 'Не представлены сертификаты на арматуру',
        responsible: 'Сидоров Сидор Сидорович',
        dueDate: '2026-12-15'
      }
    });
    assert.equal(response.status, 200);
    remarkId = response.data.data.id;
    assert.match(response.data.data.number, /^ЗМ-\d{4}-\d{3}$/);
  });

  await t.test('уведомление создаётся ответственному', async () => {
    const responsibleId = db.prepare(`SELECT "ID_сотрудника" as id FROM "Сотрудник" WHERE "Табельный_номер" = 'PTO901'`).get().id;
    const count = db.prepare('SELECT COUNT(*) as c FROM "Уведомление" WHERE "ID_сотрудника" = ?').get(responsibleId).c;
    assert.ok(count >= 1);
  });

  await t.test('смена статуса, комментарий и история', async () => {
    const status = await client.request('PATCH', `/api/remarks/${remarkId}/status`, {
      body: { status: 'В работе', comment: 'Документы запрошены у поставщика' }
    });
    assert.equal(status.status, 200);

    const comment = await client.request('POST', `/api/remarks/${remarkId}/comments`, {
      body: { text: 'Срок ответа — до пятницы' }
    });
    assert.equal(comment.status, 200);

    const detail = await client.request('GET', `/api/remarks/${remarkId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.status, 'В работе');
    assert.equal(detail.data.data.comments.length, 1);
    assert.ok(detail.data.data.history.length >= 2);
  });

  await t.test('фильтр по просроченным замечаниям', async () => {
    db.prepare('UPDATE "Замечание" SET "Срок" = ? WHERE "ID_замечания" = ?').run('2020-01-01', remarkId);
    const response = await client.request('GET', '/api/remarks?overdue=1');
    assert.equal(response.status, 200);
    assert.ok(response.data.data.some((remark) => remark.id === remarkId));
  });

  await t.test('просроченные попадают в уведомления', async () => {
    const scan = await client.request('POST', '/api/notifications/scan', { body: {} });
    assert.equal(scan.status, 200);

    const notifications = await client.request('GET', '/api/notifications');
    assert.ok(notifications.data.unread >= 0);
  });
});
