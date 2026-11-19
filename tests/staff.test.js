import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORDS } from './helpers.js';

test('сотрудники: авторизация администратора и управление учётными записями', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client, db, base } = ctx;

  const NEW_PASSWORD = 'StaffPass12345';
  const NEW_PASSWORD_2 = 'StaffPass67890';
  let createdId = null;

  await t.test('неверный пароль администратора даёт 401', async () => {
    client.reset();
    const response = await client.login('ADM900', 'WrongPassword123');
    assert.equal(response.status, 401);
    assert.equal(response.data.success, false);
  });

  await t.test('правильные учётные данные дают 200 и рабочую сессию', async () => {
    const response = await client.login('ADM900', PASSWORDS.admin);
    assert.equal(response.status, 200);
    assert.equal(response.data.user.role, 'Администратор');
    assert.equal(response.data.permissions.admin, true);
    assert.ok(response.data.csrfToken);

    const session = await client.request('GET', '/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.data.user.tabNumber, 'ADM900');
  });

  await t.test('заблокированный администратор не получает доступ', async () => {
    db.prepare('UPDATE "Сотрудник" SET "Заблокирован" = 1 WHERE "Табельный_номер" = ?').run('ADM900');
    try {
      client.reset();
      const response = await client.login('ADM900', PASSWORDS.admin);
      assert.equal(response.status, 403);
    } finally {
      db.prepare('UPDATE "Сотрудник" SET "Заблокирован" = 0 WHERE "Табельный_номер" = ?').run('ADM900');
      client.reset();
    }
  });

  await t.test('список сотрудников: 200, поля и доступ к объектам', async () => {
    await client.login('ADM900', PASSWORDS.admin);
    const response = await client.request('GET', '/api/sotrudniki');
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.data.data));
    assert.ok(response.data.data.length >= 4);

    const admin = response.data.data.find((row) => row.tabNumber === 'ADM900');
    assert.ok(admin);
    assert.equal(admin.fullName, 'Админов Админ Админович');
    assert.equal(admin.role, 'Администратор');
    assert.equal(typeof admin.demo, 'boolean');
    assert.equal(typeof admin.blocked, 'boolean');
    assert.ok(Array.isArray(admin.objectIds));
    assert.ok(admin.objectIds.includes(ctx.objectA));
    assert.ok('passwordUpdatedAt' in admin);
    // Поле updated_at у сотрудника отсутствует в схеме и не должно запрашиваться.
    assert.equal('updatedAt' in admin, false);
  });

  await t.test('анонимный запрос списка сотрудников получает 401', async () => {
    const response = await fetch(`${base}/api/sotrudniki`, { redirect: 'manual' });
    assert.equal(response.status, 401);
  });

  await t.test('инженер ПТО без прав администратора получает 403', async () => {
    const other = await setup();
    try {
      await other.client.login('PTO900', PASSWORDS.pto);
      const response = await other.client.request('GET', '/api/sotrudniki');
      assert.equal(response.status, 403);
      const create = await other.client.request('POST', '/api/sotrudniki', {
        body: { fullName: 'Чужой Сотрудник', tabNumber: 'X900', password: NEW_PASSWORD, role: 'Монтажник' }
      });
      assert.equal(create.status, 403);
    } finally {
      await other.close();
    }
  });

  await t.test('создание сотрудника и вход под новой учётной записью', async () => {
    const response = await client.request('POST', '/api/sotrudniki', {
      body: {
        fullName: 'Тестов Тест Тестович',
        tabNumber: 'T901',
        password: NEW_PASSWORD,
        role: 'Монтажник',
        objectIds: [ctx.objectA]
      }
    });
    assert.equal(response.status, 200);
    createdId = response.data.data.id;

    const list = await client.request('GET', '/api/sotrudniki');
    const row = list.data.data.find((item) => item.tabNumber === 'T901');
    assert.ok(row);
    assert.equal(row.fullName, 'Тестов Тест Тестович');
    assert.equal(row.role, 'Монтажник');
    assert.equal(row.objectIds.length, 1);
    assert.equal(row.objectIds[0], ctx.objectA);

    const login = await client.login('T901', NEW_PASSWORD);
    assert.equal(login.status, 200);
  });

  await t.test('дубликат табельного номера отклоняется (409)', async () => {
    await client.login('ADM900', PASSWORDS.admin);
    const response = await client.request('POST', '/api/sotrudniki', {
      body: { fullName: 'Дубль', tabNumber: 'T901', password: NEW_PASSWORD, role: 'Монтажник' }
    });
    assert.equal(response.status, 409);
  });

  await t.test('изменение роли сотрудника отражается в списке', async () => {
    const response = await client.request('PUT', `/api/sotrudniki/${createdId}/role`, {
      body: { role: 'Старший монтажник' }
    });
    assert.equal(response.status, 200);

    const list = await client.request('GET', '/api/sotrudniki');
    const row = list.data.data.find((item) => item.id === createdId);
    assert.equal(row.role, 'Старший монтажник');
  });

  await t.test('нельзя снять роль администратора с самого себя (403)', async () => {
    const me = (await client.request('GET', '/api/auth/session')).data.user;
    const response = await client.request('PUT', `/api/sotrudniki/${me.id}/role`, {
      body: { role: 'Монтажник' }
    });
    assert.equal(response.status, 403);
  });

  await t.test('нельзя заблокировать самого себя (403)', async () => {
    const me = (await client.request('GET', '/api/auth/session')).data.user;
    const response = await client.request('PUT', `/api/sotrudniki/${me.id}/block`, { body: { blocked: true } });
    assert.equal(response.status, 403);
  });

  await t.test('блокировка закрывает вход, разблокировка возвращает', async () => {
    const block = await client.request('PUT', `/api/sotrudniki/${createdId}/block`, { body: { blocked: true } });
    assert.equal(block.status, 200);

    const blockedLogin = await client.login('T901', NEW_PASSWORD);
    assert.equal(blockedLogin.status, 403);

    const unblock = await client.request('PUT', `/api/sotrudniki/${createdId}/block`, { body: { blocked: false } });
    assert.equal(unblock.status, 200);

    const restored = await client.login('T901', NEW_PASSWORD);
    assert.equal(restored.status, 200);
  });

  await t.test('сброс пароля администратором меняет вход', async () => {
    await client.login('ADM900', PASSWORDS.admin);
    const reset = await client.request('PUT', `/api/sotrudniki/${createdId}/password`, {
      body: { password: NEW_PASSWORD_2 }
    });
    assert.equal(reset.status, 200);

    const oldLogin = await client.login('T901', NEW_PASSWORD);
    assert.equal(oldLogin.status, 401);

    const newLogin = await client.login('T901', NEW_PASSWORD_2);
    assert.equal(newLogin.status, 200);
  });

  await t.test('изменение доступа к объектам сохраняется', async () => {
    await client.login('ADM900', PASSWORDS.admin);
    const response = await client.request('PUT', `/api/sotrudniki/${createdId}/access`, {
      body: { objectIds: [ctx.objectB] }
    });
    assert.equal(response.status, 200);

    const list = await client.request('GET', '/api/sotrudniki');
    const row = list.data.data.find((item) => item.id === createdId);
    assert.deepEqual(row.objectIds, [ctx.objectB]);
  });

  await t.test('удаление сотрудника и запись в журнале действий', async () => {
    const response = await client.request('DELETE', `/api/sotrudniki/${createdId}`);
    assert.equal(response.status, 200);

    const list = await client.request('GET', '/api/sotrudniki');
    assert.equal(list.data.data.some((item) => item.id === createdId), false);

    const audit = await client.request('GET', '/api/audit?limit=20');
    assert.equal(audit.status, 200);
    assert.ok(audit.data.data.some((entry) => entry.action === 'Удаление сотрудника'));
  });

  await t.test('существующие учётные записи и хеши не изменились', async () => {
    const rows = db.prepare('SELECT "Табельный_номер" as tab, "Должность" as role, "Пароль" as hash FROM "Сотрудник"').all();
    const admin = rows.find((row) => row.tab === 'ADM900');
    assert.equal(admin.role, 'Администратор');
    assert.match(admin.hash, /^\$2[aby]\$/);
    assert.equal(rows.length, 4);
  });
});
