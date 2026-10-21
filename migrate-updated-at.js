import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'infoteh.db');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

function getColumns(table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
}

function addColumnIfMissing(table, column, type = 'DATETIME') {
  if (getColumns(table).includes(column)) {
    console.log(`  ${table}.${column}: уже есть, пропущено`);
    return;
  }

  db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
  console.log(`  ${table}.${column}: добавлено`);
}

function renameColumnIfNeeded(table, from, to) {
  const columns = getColumns(table);

  if (!columns.includes(from)) {
    console.log(`  ${table}.${from}: нет, переименование не требуется`);
    return;
  }

  if (columns.includes(to)) {
    console.log(`  ${table}.${to}: уже есть, переименование не требуется`);
    return;
  }

  db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${from}" TO "${to}"`);
  console.log(`  ${table}.${from} -> ${table}.${to}: переименовано`);
}

const migrate = db.transaction(() => {
  console.log('Схема:');

  renameColumnIfNeeded('Статья', 'Фото', 'Файл');

  addColumnIfMissing('Статья', 'updated_at');
  addColumnIfMissing('Работа', 'updated_at');
  addColumnIfMissing('Виды_работ', 'updated_at');

  const now = db.prepare(`SELECT datetime('now', 'localtime') as value`).get().value;

  db.prepare(`
    UPDATE "Статья"
    SET "updated_at" = COALESCE(
      NULLIF("updated_at", ''),
      CASE
        WHEN "Дата_публикации" IS NULL OR "Дата_публикации" = '' THEN ?
        ELSE "Дата_публикации" || ' 00:00:00'
      END
    )
  `).run(now);

  db.prepare(`
    UPDATE "Работа"
    SET "updated_at" = COALESCE(NULLIF("updated_at", ''), ?)
  `).run(now);

  db.prepare(`
    UPDATE "Виды_работ"
    SET "updated_at" = COALESCE(NULLIF("updated_at", ''), ?)
  `).run(now);

  console.log('Данные: стартовые значения updated_at заполнены');
});

migrate();
db.close();

console.log('');
console.log(`Готово. База: ${dbPath}`);
