import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

test('миграции: создание схемы, повторный запуск, обновление старой БД', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infoteh-migrate-'));
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
  process.env.DATABASE_PATH = path.join(dir, 'legacy.db');
  process.env.UPLOADS_PATH = path.join(dir, 'uploads');
  process.env.LOG_PATH = path.join(dir, 'logs');
  process.env.BACKUP_PATH = path.join(dir, 'backups');

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Создаём «старую» базу: только таблица сотрудников, без новых полей.
  const legacy = new Database(process.env.DATABASE_PATH);
  legacy.exec(`
    CREATE TABLE "Сотрудник" (
      "ID_сотрудника" INTEGER PRIMARY KEY AUTOINCREMENT,
      "Табельный_номер" TEXT NOT NULL UNIQUE,
      "Пароль" TEXT NOT NULL,
      "ФИО" TEXT NOT NULL,
      "Должность" TEXT NOT NULL
    );
  `);
  legacy.close();

  const { openDatabase } = await import('../lib/db.js');

  await t.test('миграции добавляют недостающие таблицы и поля', () => {
    const db = openDatabase();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);

    for (const table of ['Сотрудник', 'Виды_работ', 'Работа', 'Статья', 'Объект', 'Документ_ПТО', 'История_ПТО', 'Редакция_ПТО', 'Замечание', 'Комплект', 'Уведомление', 'Аудит', 'Сессия']) {
      assert.ok(tables.includes(table), `нет таблицы ${table}`);
    }

    const columns = db.prepare('PRAGMA table_info("Сотрудник")').all().map((row) => row.name);
    assert.ok(columns.includes('Демо'));
    assert.ok(columns.includes('Заблокирован'));

    const docColumns = db.prepare('PRAGMA table_info("Документ_ПТО")').all().map((row) => row.name);
    assert.ok(docColumns.includes('Текст_извлечён'));
    assert.ok(docColumns.includes('Требуется_OCR'));

    db.close();
  });

  await t.test('повторный запуск миграций безопасен', () => {
    const db = openDatabase();
    const applied = db.prepare('SELECT COUNT(*) as c FROM "Миграции"').get().c;
    db.close();

    const db2 = openDatabase();
    const appliedAgain = db2.prepare('SELECT COUNT(*) as c FROM "Миграции"').get().c;
    db2.close();

    assert.equal(applied, appliedAgain);
    assert.ok(applied >= 6);
  });

  await t.test('внешние ключи включены, режим WAL', () => {
    const db = openDatabase();
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.close();
  });
});
