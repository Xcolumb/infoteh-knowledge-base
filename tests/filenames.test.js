import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORDS } from './helpers.js';
import { makeDocx, makeXlsx, makePdf } from './fixtures.js';

const CYRILLIC_FILES = [
  { name: 'Исполнительная документация по электроснабжению здания.docx', buffer: () => makeDocx({ title: 'Электроснабжение' }), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { name: 'Ведомость объёмов работ — Балаково (ред. 2).xlsx', buffer: () => makeXlsx({ sheets: [{ name: 'Объёмы', rows: [['Работа', 'Кол-во']] }] }), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { name: 'ИД_ЦОД_№12_финальная версия.pdf', buffer: () => makePdf('ID-12'), type: 'application/pdf' },
  { name: 'Смета + материалы (2026).xlsx', buffer: () => makeXlsx({ sheets: [{ name: 'Смета', rows: [['Позиция', 'Сумма']] }] }), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { name: 'Отчёт инженера ПТО.docx', buffer: () => makeDocx({ title: 'Отчёт' }), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
];

function uploadForm({ objectId, name, buffer, type }) {
  const form = new FormData();
  form.append('type', 'Исполнительная документация');
  form.append('title', `Документ: ${name}`);
  form.append('status', 'Черновик');
  form.append('objectId', String(objectId));
  form.append('docFile', new File([buffer], name, { type }));
  return form;
}

test('кириллица в именах файлов: загрузка, БД, API, скачивание', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client, db } = ctx;

  await client.login('PTO900', PASSWORDS.pto);

  const created = [];

  await t.test('пять файлов с русскими именами загружаются без искажений', async () => {
    for (const file of CYRILLIC_FILES) {
      const response = await client.request('POST', '/api/pto', {
        multipart: true,
        body: uploadForm({ objectId: ctx.objectA, name: file.name, buffer: file.buffer(), type: file.type })
      });

      assert.equal(response.status, 200, `${file.name}: ${JSON.stringify(response.data)}`);
      created.push({ id: response.data.data.id, name: file.name });
    }
  });

  await t.test('имя в SQLite совпадает с исходным', () => {
    for (const item of created) {
      const row = db.prepare('SELECT "Оригинальное_имя" as name FROM "Документ_ПТО" WHERE "ID_документа" = ?').get(item.id);
      assert.equal(row.name, item.name);
    }
  });

  await t.test('имя возвращается в карточке и реестре без изменений', async () => {
    for (const item of created) {
      const detail = await client.request('GET', `/api/pto/${item.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.data.data.originalName, item.name);

      const revisions = detail.data.data.revisions;
      assert.ok(revisions.length >= 1, 'должна быть запись редакции');
      assert.equal(revisions[0].originalName, item.name);
    }
  });

  await t.test('скачивание сохраняет кириллическое имя (RFC 5987)', async () => {
    for (const item of created) {
      const response = await client.request('GET', `/api/files/document/${item.id}?disposition=attachment`);
      assert.equal(response.status, 200);

      const header = response.headers.get('content-disposition');
      assert.ok(header.startsWith('attachment;'), header);
      assert.ok(!header.includes('Ð'), 'в заголовке не должно быть mojibake');
      const encoded = /filename\*=UTF-8''([^;]+)/.exec(header);
      assert.ok(encoded, 'в заголовке должен быть filename* по RFC 5987');
      assert.equal(decodeURIComponent(encoded[1]), item.name);
    }
  });

  await t.test('просмотр PDF отдаётся inline, офисные форматы — attachment', async () => {
    const pdf = created.find((item) => item.name.endsWith('.pdf'));
    const docx = created.find((item) => item.name.endsWith('.docx'));

    const inline = await client.request('GET', `/api/files/document/${pdf.id}?disposition=inline`);
    assert.ok(inline.headers.get('content-disposition').startsWith('inline;'));

    const officeInline = await client.request('GET', `/api/files/document/${docx.id}?disposition=inline`);
    assert.ok(officeInline.headers.get('content-disposition').startsWith('attachment;'), 'DOCX не должен открываться как inline');
    assert.equal(officeInline.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});
