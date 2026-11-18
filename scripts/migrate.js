// Явный запуск миграций БД (без старта сервера).
// Запуск: npm run migrate
import config from '../config.js';
import { openDatabase } from '../lib/db.js';
import { migrations } from '../lib/migrations/index.js';

const db = openDatabase();
const applied = db.prepare('SELECT "Название" as name, "Применена" as appliedAt FROM "Миграции" ORDER BY "ID"').all();
db.close();

console.log(`База: ${config.databasePath}`);
console.log(`Всего миграций в коде: ${migrations.length}`);
console.log('Применены:');
for (const row of applied) {
  console.log(`  ${row.name} — ${row.appliedAt}`);
}
