import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'infoteh.db');
const BCRYPT_ROUNDS = 10;
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const employees = db.prepare(`
  SELECT
    "ID_сотрудника" as id,
    "Табельный_номер" as tabNumber,
    "Пароль" as password
  FROM "Сотрудник"
`).all();

const updatePassword = db.prepare(`
  UPDATE "Сотрудник" SET "Пароль" = ? WHERE "ID_сотрудника" = ?
`);

let hashed = 0;
let skipped = 0;

const migrate = db.transaction(() => {
  for (const employee of employees) {
    if (!employee.password) {
      console.warn(`  #${employee.id} (${employee.tabNumber}): пустой пароль, пропущен`);
      skipped += 1;
      continue;
    }

    if (BCRYPT_HASH_RE.test(employee.password)) {
      console.log(`  #${employee.id} (${employee.tabNumber}): уже bcrypt, пропущен`);
      skipped += 1;
      continue;
    }

    const hash = bcrypt.hashSync(employee.password, BCRYPT_ROUNDS);
    updatePassword.run(hash, employee.id);
    hashed += 1;
    console.log(`  #${employee.id} (${employee.tabNumber}): пароль захеширован`);
  }
});

migrate();
db.close();

console.log('');
console.log(`Готово: захешировано ${hashed}, пропущено ${skipped}. База: ${dbPath}`);
