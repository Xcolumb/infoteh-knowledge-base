import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, PASSWORDS } from './helpers.js';
import { makeDocx, makeXlsx, makePdf, makePng } from './fixtures.js';

function buildForm({ objectId, name, buffer, type, title = 'Документ для просмотра' }) {
  const form = new FormData();
  form.append('type', 'Исполнительная документация');
  form.append('title', title);
  form.append('status', 'Черновик');
  form.append('objectId', String(objectId));
  form.append('docFile', new File([buffer], name, { type }));
  return form;
}

async function upload(client, options) {
  const response = await client.request('POST', '/api/pto', { multipart: true, body: buildForm(options) });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.data.id;
}

test('встроенный просмотр документов', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.close());
  const { client, db } = ctx;

  await client.login('PTO900', PASSWORDS.pto);

  let docxId;
  let xlsxId;
  let pdfId;
  let pngId;
  let csvId;

  await t.test('DOCX: содержимое отдаётся как безопасный HTML', async () => {
    docxId = await upload(client, {
      objectId: ctx.objectA,
      name: 'Инструкция ПТО.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: makeDocx({
        title: 'Заголовок документа',
        paragraphs: ['Первый абзац текста', '<script>alert(1)</script>'],
        table: { headers: ['Позиция', 'Значение'], rows: [['Акт', '12']] }
      })
    });

    const meta = await client.request('GET', `/api/preview/document/${docxId}`);
    assert.equal(meta.status, 200);
    assert.equal(meta.data.data.mode, 'html');
    assert.equal(meta.data.data.kind, 'docx');

    const content = await client.request('GET', `/api/preview/document/${docxId}/content`);
    assert.equal(content.status, 200);
    assert.ok(content.data.data.html.includes('Первый абзац текста'));
    assert.ok(content.data.data.html.includes('<table'), 'таблица должна отображаться');
    assert.ok(!content.data.data.html.includes('<script'), 'скрипты не должны попадать в HTML');
    assert.ok(content.data.data.html.includes('&lt;script&gt;'), 'опасный текст должен быть экранирован');
  });

  await t.test('XLSX: возвращаются листы и ячейки', async () => {
    xlsxId = await upload(client, {
      objectId: ctx.objectA,
      name: 'Ведомость.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: makeXlsx({
        sheets: [
          { name: 'Объёмы', rows: [['Работа', 'Кол-во', 'Ед.'], ['Монтаж', 12, 'м']] },
          { name: 'Итоги', rows: [['Всего', 42]] }
        ]
      })
    });

    const meta = await client.request('GET', `/api/preview/document/${xlsxId}`);
    assert.equal(meta.data.data.mode, 'table');

    const content = await client.request('GET', `/api/preview/document/${xlsxId}/content`);
    assert.equal(content.status, 200);
    assert.equal(content.data.data.sheets.length, 2);
    assert.equal(content.data.data.sheets[0].name, 'Объёмы');
    assert.deepEqual(content.data.data.sheets[0].rows[0], ['Работа', 'Кол-во', 'Ед.']);
    assert.equal(content.data.data.sheets[0].rows[1][1], '12');
    assert.equal(content.data.data.sheets[1].name, 'Итоги');
  });

  await t.test('PDF: встроенный режим и отдельное скачивание', async () => {
    pdfId = await upload(client, {
      objectId: ctx.objectA,
      name: 'ИД ЦОД №12.pdf',
      type: 'application/pdf',
      buffer: makePdf('ID 12')
    });

    const meta = await client.request('GET', `/api/preview/document/${pdfId}`);
    assert.equal(meta.data.data.mode, 'iframe');

    const inline = await client.request('GET', `/api/files/document/${pdfId}?disposition=inline`);
    assert.equal(inline.status, 200);
    assert.ok(inline.headers.get('content-disposition').startsWith('inline;'));

    const download = await client.request('GET', `/api/files/document/${pdfId}?disposition=attachment`);
    assert.ok(download.headers.get('content-disposition').startsWith('attachment;'));
  });

  await t.test('PNG: изображение показывается в просмотрщике', async () => {
    pngId = await upload(client, {
      objectId: ctx.objectA,
      name: 'Схема узла.png',
      type: 'image/png',
      buffer: makePng()
    });

    const meta = await client.request('GET', `/api/preview/document/${pngId}`);
    assert.equal(meta.data.data.mode, 'iframe');
    assert.equal(meta.data.data.kind, 'image');

    const inline = await client.request('GET', `/api/files/document/${pngId}?disposition=inline`);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'image/png');
  });

  await t.test('CSV и TXT отображаются как таблица и текст', async () => {
    csvId = await upload(client, {
      objectId: ctx.objectA,
      name: 'Ведомость.csv',
      type: 'text/csv',
      buffer: Buffer.from('Позиция;Кол-во\nМонтаж;12\n', 'utf8')
    });

    const csvMeta = await client.request('GET', `/api/preview/document/${csvId}`);
    assert.equal(csvMeta.data.data.mode, 'table');

    const csvContent = await client.request('GET', `/api/preview/document/${csvId}/content`);
    assert.deepEqual(csvContent.data.data.rows[0], ['Позиция', 'Кол-во']);

    const txtId = await upload(client, {
      objectId: ctx.objectA,
      name: 'Примечание.txt',
      type: 'text/plain',
      buffer: Buffer.from('Простой текст без HTML', 'utf8')
    });

    const txtMeta = await client.request('GET', `/api/preview/document/${txtId}`);
    assert.equal(txtMeta.data.data.mode, 'text');

    const txtContent = await client.request('GET', `/api/preview/document/${txtId}/content`);
    assert.equal(txtContent.data.data.text, 'Простой текст без HTML');
  });

  await t.test('старый DOC: поддерживаемый или понятно неподдерживаемый', async () => {
    const docId = await upload(client, {
      objectId: ctx.objectA,
      name: 'Старый акт.doc',
      type: 'application/msword',
      buffer: Buffer.from('legacy doc content')
    });

    const meta = await client.request('GET', `/api/preview/document/${docId}`);
    assert.equal(meta.status, 200);
    assert.ok(['converted', 'unsupported'].includes(meta.data.data.mode));

    if (meta.data.data.mode === 'unsupported') {
      assert.ok(meta.data.data.notes.some((note) => note.includes('Предварительный просмотр этого формата недоступен')));
    }
  });

  await t.test('каждая редакция открывается отдельно и различается', async () => {
    const updateForm = new FormData();
    updateForm.append('type', 'Исполнительная документация');
    updateForm.append('title', 'Документ для просмотра');
    updateForm.append('status', 'На проверке');
    updateForm.append('objectId', String(ctx.objectA));
    updateForm.append('docFile', new File([makeDocx({ title: 'Вторая редакция', paragraphs: ['Текст версии 2'] })], 'Инструкция ПТО (ред. 2).docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }));

    const update = await client.request('PUT', `/api/pto/${docxId}`, { multipart: true, body: updateForm });
    assert.equal(update.status, 200);

    const detail = await client.request('GET', `/api/pto/${docxId}`);
    const revisions = detail.data.data.revisions;
    assert.equal(revisions.length, 2);

    const older = revisions.find((revision) => revision.version === 1);
    const newer = revisions.find((revision) => revision.version === 2);

    const olderMeta = await client.request('GET', `/api/preview/revision/${older.id}`);
    assert.equal(olderMeta.data.data.isCurrent, false);

    const olderContent = await client.request('GET', `/api/preview/revision/${older.id}/content`);
    assert.ok(olderContent.data.data.html.includes('Первый абзац текста'));

    const newerMeta = await client.request('GET', `/api/preview/revision/${newer.id}`);
    assert.equal(newerMeta.data.data.isCurrent, true);

    const newerContent = await client.request('GET', `/api/preview/revision/${newer.id}/content`);
    assert.ok(newerContent.data.data.html.includes('Текст версии 2'));
  });

  await t.test('вложение замечания тоже просматривается', async () => {
    const remark = await client.request('POST', '/api/remarks', {
      body: { objectId: ctx.objectA, description: 'Замечание с вложением' }
    });
    const remarkId = remark.data.data.id;

    const form = new FormData();
    form.append('file', new File([makePdf('attachment')], 'Замечание.pdf', { type: 'application/pdf' }));
    const attached = await client.request('POST', `/api/remarks/${remarkId}/attachments`, { multipart: true, body: form });
    assert.equal(attached.status, 200);

    const detail = await client.request('GET', `/api/remarks/${remarkId}`);
    const attachment = detail.data.data.attachments[0];

    const meta = await client.request('GET', `/api/preview/remark/${attachment.id}`);
    assert.equal(meta.status, 200);
    assert.equal(meta.data.data.mode, 'iframe');
  });

  await t.test('анонимный доступ к просмотру запрещён', async () => {
    const response = await fetch(`${ctx.base}/api/preview/document/${docxId}`, { redirect: 'manual' });
    assert.equal(response.status, 401);
  });

  await t.test('пользователь без доступа к объекту получает 404', async () => {
    const docB = await upload(client, {
      objectId: ctx.objectB,
      name: 'Документ объекта Б.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: makeDocx({ title: 'Объект Б' })
    });

    await client.login('PTO901', PASSWORDS.pto2);
    const meta = await client.request('GET', `/api/preview/document/${docB}`);
    assert.equal(meta.status, 404);

    const content = await client.request('GET', `/api/preview/document/${docB}/content`);
    assert.equal(content.status, 404);
  });

  await t.test('просмотр фиксируется в журнале аудита', async () => {
    await client.login('ADM900', PASSWORDS.admin);
    const audit = await client.request('GET', '/api/audit?limit=200');
    assert.equal(audit.status, 200);
    assert.ok(audit.data.data.some((entry) => entry.action === 'Просмотр документа'));
    void db;
  });
});
