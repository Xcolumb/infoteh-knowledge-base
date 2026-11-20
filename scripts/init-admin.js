// Одноразовая локальная инициализация после npm run migrate.
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import { text, password } from '../lib/validate.js';

try {
  const tabNumber = text(process.env.INIT_ADMIN_TAB, { field: 'Табельный номер', required: true, max: 40 });
  const fullName = text(process.env.INIT_ADMIN_NAME, { field: 'ФИО', required: true, max: 150 });
  const secret = password(process.env.INIT_ADMIN_PASSWORD, { tabNumber });
  if (Buffer.byteLength(secret, 'utf8') > 72) throw new Error('Для bcrypt пароль должен занимать не более 72 байт');
  const hash = bcrypt.hashSync(secret, 10);

  const db = new Database(config.databasePath, { fileMustExist: true });
  try {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM "Сотрудник" LIMIT 1').get()) {
        throw new Error('Инициализация доступна только до создания первого сотрудника');
      }
      db.prepare(`INSERT INTO "Сотрудник" ("Табельный_номер", "Пароль", "ФИО", "Должность", "Демо")
        VALUES (?, ?, ?, 'Администратор', 0)`).run(tabNumber, hash, fullName);
    }).immediate();
  } finally {
    db.close();
  }
  console.log('Первоначальный администратор создан.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
