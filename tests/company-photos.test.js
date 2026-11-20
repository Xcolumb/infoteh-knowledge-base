import test from 'node:test';
import assert from 'node:assert/strict';
import { makePng } from './fixtures.js';
import { createClient, PASSWORDS, setup } from './helpers.js';

test('Галерея строительства доступна сотрудникам, загрузка — только администратору с CSRF', async t => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const url = '/api/company/photos';
  const png = makePng();
  const upload = (client, bytes = png, csrf = true) => {
    const body = new FormData();
    body.append('photo', new File([bytes], 'объект.png', { type: 'image/png' }));
    return client.request('POST', url, { body, multipart: true, csrf });
  };
  const admin = ctx.client;
  assert.equal((await admin.request('GET', url)).status, 401);
  assert.equal((await upload(admin)).status, 401);
  await admin.login('ADM900', PASSWORDS.admin);
  assert.deepEqual((await admin.request('GET', url)).data.photos, []);
  assert.equal((await upload(admin, png, false)).status, 403);
  assert.equal((await upload(admin, Buffer.from('Это текстовый файл'))).status, 400);
  assert.deepEqual((await admin.request('GET', url)).data.photos, []);
  const results = await Promise.all([upload(admin), upload(admin)]);
  assert.ok(results.every(r => r.status === 200));
  const names = results.map(r => r.data.name);
  assert.equal(new Set(names).size, 2);
  for (const [tab, password, role] of [['PTO900', PASSWORDS.pto, 'Инженер ПТО'],
    ['M900', PASSWORDS.worker, 'Монтажник'], ['M900', PASSWORDS.worker, 'Старший монтажник']]) {
    ctx.db.prepare('UPDATE Сотрудник SET Должность=? WHERE Табельный_номер=?').run(role, tab);
    const client = createClient(ctx.base);
    await client.login(tab, password);
    assert.equal((await upload(client)).status, 403);
    assert.deepEqual((await client.request('GET', url)).data.photos.sort(), [...names].sort());
    const photo = await client.request('GET', url + '/' + names[0]);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/png');
    assert.equal(Number(photo.headers.get('content-length')), png.length);
    assert.equal((await client.request('GET', url + '/document.png')).status, 404);
  }
  assert.equal((await createClient(ctx.base).request('GET', url + '/' + names[0])).status, 401);
});
