// Отчёт о ранее загруженных файлах с искажёнными (mojibake) именами.
// По умолчанию — только чтение (dry-run): формирует CSV-отчёт и ничего не меняет.
// Применение исправлений: npm run report-filenames -- --apply
// Физические файлы не переименовываются ни в одном режиме.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import config from '../config.js';
import { decodeUploadFileName } from '../lib/validate.js';

const apply = process.argv.includes('--apply');
const reportPath = path.resolve(process.cwd(), 'reports', 'filename-repair-dry-run.csv');

const TABLES = [
  { table: 'Документ_ПТО', id: 'ID_документа', name: 'Оригинальное_имя', file: 'Файл' },
  { table: 'Редакция_ПТО', id: 'ID_редакции', name: 'Оригинальное_имя', file: 'Файл' },
  { table: 'Статья', id: 'ID_статьи', name: 'Оригинальное_имя', file: 'Файл' },
  { table: 'Вложение_замечания', id: 'ID_вложения', name: 'Оригинальное_имя', file: 'Файл' }
];

const db = new Database(config.databasePath, { readonly: !apply, fileMustExist: true });

function csvCell(value) {
  const text = String(value ?? '');
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const rows = [];
let broken = 0;
let repairable = 0;

for (const definition of TABLES) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(definition.table);
  if (!exists) continue;

  const records = db.prepare(`SELECT "${definition.id}" as id, "${definition.name}" as name, "${definition.file}" as file FROM "${definition.table}"`).all();

  for (const record of records) {
    const current = String(record.name || '');
    if (!current) continue;

    const decoded = decodeUploadFileName(current);
    const isBroken = decoded !== current;
    if (!isBroken) continue;

    broken += 1;
    const repairableHere = !decoded.includes('\uFFFD');
    if (repairableHere) repairable += 1;

    rows.push({
      table: definition.table,
      id: record.id,
      current,
      physical: record.file || '',
      suggested: decoded,
      repairable: repairableHere ? 'да' : 'нет',
      reason: repairableHere ? 'однозначное восстановление UTF-8 из Latin-1' : 'неоднозначно: требуется ручная проверка'
    });

    if (apply && repairableHere) {
      db.prepare(`UPDATE "${definition.table}" SET "${definition.name}" = ? WHERE "${definition.id}" = ?`).run(decoded, record.id);
    }
  }
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });

const header = ['Таблица', 'ID', 'Текущее имя', 'Физический файл', 'Предполагаемое имя', 'Восстановимо', 'Основание'];
const lines = [header.map(csvCell).join(';')];
for (const row of rows) {
  lines.push([row.table, row.id, row.current, row.physical, row.suggested, row.repairable, row.reason].map(csvCell).join(';'));
}

fs.writeFileSync(reportPath, '\uFEFF' + lines.join('\r\n'), 'utf8');
db.close();

console.log(`Режим: ${apply ? 'ПРИМЕНЕНИЕ исправлений (только БД)' : 'dry-run (без изменений)'}`);
console.log(`Найдено искажённых имён: ${broken}`);
console.log(`Однозначно восстановимых: ${repairable}`);
console.log(`Отчёт: ${reportPath}`);
if (apply) console.log('Физические файлы не переименовывались.');
