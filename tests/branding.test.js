import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('брендинг: «Информационная система ПТО»', async (t) => {
  const ctx = await setup({ seed: false });
  t.after(() => ctx.close());

  const response = await fetch(`${ctx.base}/`, { redirect: 'manual' });
  const html = await response.text();

  await t.test('страница входа содержит новое название и подзаголовок', () => {
    assert.equal(response.status, 200);
    assert.ok(html.includes('<h1>Информационная система ПТО</h1>'), 'новый H1 на экране входа');
    assert.ok(html.includes('Документы · Комплектность ИД · Замечания · База знаний'), 'подзаголовок');
  });

  await t.test('document.title обновлён', () => {
    assert.ok(html.includes('<title>Информационная система ПТО — ООО «ИНФОТЕХ БАЛАКОВО»</title>'));
  });

  await t.test('в подвале новое название и назначение', () => {
    assert.ok(html.includes('Информационная система ПТО'));
    assert.ok(html.includes('Цифровые инструменты производственно-технического отдела'));
  });

  await t.test('старое брендовое название отсутствует', () => {
    assert.ok(!html.includes('База знаний для монтажников'), 'старое название не должно выводиться');
    assert.ok(!html.toLowerCase().includes('база знаний монтажников'));
  });

  await t.test('раздел «Каталог знаний» сохранён', () => {
    assert.ok(html.includes('data-page="catalog"'));
    assert.ok(html.includes('Каталог знаний'));
  });

  await t.test('роли пользователей не переименованы', () => {
    assert.ok(html.includes('Инженер ПТО'));
    assert.ok(html.includes('Старший монтажник'));
    assert.ok(html.includes('Администратор'));
  });

  await t.test('наименование организации сохранено', () => {
    assert.ok(html.includes('ООО «ИНФОТЕХ БАЛАКОВО»'));
  });

  await t.test('на экране входа нет старой подписи продукта', () => {
    const loginBlock = html.slice(html.indexOf('id="login-page"'), html.indexOf('id="app-page"'));
    assert.ok(!loginBlock.includes('База знаний для монтажников'));
    assert.ok(loginBlock.includes('Информационная система ПТО'));
  });
});
