import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORDS } from './helpers.js';

test('авторизация, роли и смена пароля', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client } = ctx;

  await t.test('анонимный запрос получает 401', async () => {
    const response = await client.request('GET', '/api/articles');
    assert.equal(response.status, 401);
  });

  await t.test('неверный пароль отклонён', async () => {
    const response = await client.login('PTO900', 'wrong-password-1');
    assert.equal(response.status, 401);
    assert.equal(response.data.success, false);
  });

  await t.test('успешный вход выдаёт CSRF и права', async () => {
    const response = await client.login('PTO900', PASSWORDS.pto);
    assert.equal(response.status, 200);
    assert.equal(response.data.user.role, 'Инженер ПТО');
    assert.ok(response.data.csrfToken.length >= 32);
    assert.equal(response.data.permissions.pto, true);
    assert.equal(response.data.permissions.admin, false);
  });

  await t.test('сессия восстанавливается по cookie', async () => {
    const response = await client.request('GET', '/api/auth/session');
    assert.equal(response.status, 200);
    assert.equal(response.data.user.tabNumber, 'PTO900');
  });

  await t.test('запрос без CSRF отклоняется', async () => {
    const response = await client.request('POST', '/api/objects', {
      body: { name: 'Объект без CSRF' },
      csrf: false
    });
    assert.equal(response.status, 403);
  });

  await t.test('смена пароля: неверный текущий пароль', async () => {
    const response = await client.request('POST', '/api/auth/password', {
      body: { currentPassword: 'wrong-pass-1', newPassword: 'NewVeryStrong123' }
    });
    assert.equal(response.status, 403);
  });

  await t.test('смена пароля: слабый пароль отклонён', async () => {
    const response = await client.request('POST', '/api/auth/password', {
      body: { currentPassword: PASSWORDS.pto, newPassword: 'short' }
    });
    assert.equal(response.status, 400);
  });

  await t.test('смена пароля: успешная смена и вход с новым паролем', async () => {
    const response = await client.request('POST', '/api/auth/password', {
      body: { currentPassword: PASSWORDS.pto, newPassword: 'NewVeryStrong123' }
    });
    assert.equal(response.status, 200);

    client.reset();
    const oldLogin = await client.login('PTO900', PASSWORDS.pto);
    assert.equal(oldLogin.status, 401);

    const newLogin = await client.login('PTO900', 'NewVeryStrong123');
    assert.equal(newLogin.status, 200);
  });

  await t.test('выход завершает сессию', async () => {
    const response = await client.request('POST', '/api/auth/logout', { body: {} });
    assert.equal(response.status, 200);

    const protectedResponse = await client.request('GET', '/api/pto');
    assert.equal(protectedResponse.status, 401);
  });

  await t.test('блокировка после серии неудачных попыток', async () => {
    client.reset();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await client.login('PTO901', 'bad-password-' + attempt);
    }
    const blocked = await client.login('PTO901', PASSWORDS.pto2);
    assert.equal(blocked.status, 429);
  });
});

test('разграничение прав: интерфейс и API', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());

  await t.test('монтажник не может создавать документы', async () => {
    const { client } = ctx;
    await client.login('M900', PASSWORDS.worker);
    const response = await client.request('POST', '/api/objects', { body: { name: 'Объект монтажника' } });
    assert.equal(response.status, 403);
  });

  await t.test('старший монтажник не управляет документами ПТО', async () => {
    const { client, db } = ctx;
    client.reset();
    db.prepare(`UPDATE "Сотрудник" SET "Должность" = 'Старший монтажник' WHERE "Табельный_номер" = 'M900'`).run();
    await client.login('M900', PASSWORDS.worker);
    const response = await client.request('GET', '/api/pto/meta');
    assert.equal(response.status, 200);
    assert.equal(response.data.canManage, false);
  });
});
