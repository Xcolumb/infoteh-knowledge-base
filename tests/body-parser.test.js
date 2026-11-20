import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { setup, docForm, pdfFile, PASSWORDS } from './helpers.js';

test('PTO-06: Express использует исправленный body-parser', () => {
  const require = createRequire(import.meta.url);
  const fromExpress = createRequire(require.resolve('express'));
  const [major, minor] = fromExpress('body-parser/package.json').version.split('.').map(Number);
  assert.ok(major === 2 && minor >= 4 || major > 2);
});

test('PTO-06: формы, JSON, CSRF и multipart проходят через штатный HTTP-стек', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const login = await fetch(ctx.base + '/api/auth/login', {
    method: 'POST', body: new URLSearchParams({ tabNumber: 'PTO901', password: PASSWORDS.pto2 })
  });
  assert.equal(login.status, 200);
  const { csrfToken } = await login.json();
  assert.ok(csrfToken);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const headers = { cookie, 'content-type': 'application/json' };
  const body = JSON.stringify({ name: 'Проверка JSON' });
  const post = (resource, options) => fetch(ctx.base + '/api/' + resource, { method: 'POST', ...options });
  assert.equal((await post('objects', { headers, body })).status, 403);
  const created = await post('objects', { headers: { ...headers, 'x-csrf-token': csrfToken }, body });
  assert.equal(created.status, 200);
  const objectId = (await created.json()).data.id;
  const form = docForm({ title: 'Проверка multipart', objectId, file: pdfFile() });
  const doc = await post('pto', { headers: { cookie, 'x-csrf-token': csrfToken }, body: form });
  assert.equal(doc.status, 200);
  const file = await fetch(ctx.base + '/api/files/document/' + (await doc.json()).data.id, { headers: { cookie } });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'PDF-TEST-CONTENT');
});
