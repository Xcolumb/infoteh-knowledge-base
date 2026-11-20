import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import bcrypt from 'bcryptjs';

export const PASSWORDS = {
  admin: 'AdminPass12345',
  pto: 'PtoPass12345',
  pto2: 'PtoTwoPass12345',
  worker: 'WorkerPass12345'
};

export function seedData(db) {
  const insertEmployee = db.prepare(`
    INSERT INTO "Сотрудник" ("Табельный_номер", "Пароль", "ФИО", "Должность", "Демо", "Заблокирован")
    VALUES (?, ?, ?, ?, 0, 0)
  `);

  insertEmployee.run('ADM900', bcrypt.hashSync(PASSWORDS.admin, 10), 'Админов Админ Админович', 'Администратор');
  insertEmployee.run('PTO900', bcrypt.hashSync(PASSWORDS.pto, 10), 'Петров Пётр Петрович', 'Инженер ПТО');
  insertEmployee.run('PTO901', bcrypt.hashSync(PASSWORDS.pto2, 10), 'Сидоров Сидор Сидорович', 'Инженер ПТО');
  insertEmployee.run('M900', bcrypt.hashSync(PASSWORDS.worker, 10), 'Монтажников Иван Иванович', 'Монтажник');

  const employees = db.prepare('SELECT "ID_сотрудника" as id, "Табельный_номер" as tab FROM "Сотрудник"').all();
  const byTab = Object.fromEntries(employees.map((row) => [row.tab, row.id]));

  const insertObject = db.prepare(`
    INSERT INTO "Объект" ("Название", "Адрес", "Заказчик", "updated_at")
    VALUES (?, ?, ?, datetime('now', 'localtime'))
  `);

  insertObject.run('Объект А (тест)', 'адрес А', 'Заказчик А');
  insertObject.run('Объект Б (тест)', 'адрес Б', 'Заказчик Б');

  const objects = db.prepare('SELECT "ID_объекта" as id, "Название" as name FROM "Объект"').all();
  const objectA = objects.find((row) => row.name.startsWith('Объект А')).id;
  const objectB = objects.find((row) => row.name.startsWith('Объект Б')).id;

  const grant = db.prepare('INSERT OR IGNORE INTO "Доступ_объект" ("ID_сотрудника", "ID_объекта") VALUES (?, ?)');
  for (const tab of ['ADM900', 'PTO900', 'M900']) {
    grant.run(byTab[tab], objectA);
    grant.run(byTab[tab], objectB);
  }
  grant.run(byTab.PTO901, objectA);

  const insertDoc = db.prepare(`
    INSERT INTO "Документ_ПТО" (
      "Тип", "Название", "ID_объекта", "Шифр", "Раздел_проекта", "Статус", "Срок",
      "Ответственный", "Текст", "ID_автора", "Версия", "Актуализирован", "updated_at"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, date('now', 'localtime'), datetime('now', 'localtime'))
  `);

  insertDoc.run('ППР', 'ППР объекта А', objectA, 'A-001', 'КЖ', 'Черновик', '2026-12-01', 'Петров Пётр Петрович', 'Описание ППР А', byTab.PTO900);
  insertDoc.run('Исполнительная документация', 'ИД объекта Б', objectB, 'B-001', 'ЭОМ', 'Утверждён', '2026-11-01', 'Петров Пётр Петрович', 'Описание ИД Б', byTab.PTO900);

  return { byTab, objectA, objectB };
}

export function createClient(base) {
  let cookie = '';
  let csrf = '';

  async function request(method, url, { body, headers = {}, multipart = false, csrf: withCsrf = true } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (cookie) init.headers.cookie = cookie;
    if (csrf && withCsrf) init.headers['x-csrf-token'] = csrf;

    if (body !== undefined) {
      if (multipart) {
        init.body = body;
      } else {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const response = await fetch(base + url, init);
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(';')[0];
      if (pair.startsWith('infoteh.sid=')) cookie = pair;
    }

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    return { status: response.status, data, text, headers: response.headers };
  }

  async function login(tabNumber, password) {
    const response = await request('POST', '/api/auth/login', { body: { tabNumber, password } });
    if (response.data && response.data.csrfToken) csrf = response.data.csrfToken;
    return response;
  }

  return {
    request,
    login,
    get csrfToken() { return csrf; },
    reset() { cookie = ''; csrf = ''; }
  };
}

export async function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infoteh-test-'));

  // Конфигурация читается один раз на процесс, поэтому для повторных setup()
  // в одном файле переопределяем пути уже загруженного объекта config.
  const configModule = await import('../config.js');
  const config = configModule.default;
  config.databasePath = path.join(dir, 'test.db');
  config.uploadsPath = path.join(dir, 'uploads');
  config.backupPath = path.join(dir, 'backups');
  config.logPath = path.join(dir, 'logs');
  config.isProduction = false;
  config.isTest = true;
  config.allowDemoAccounts = true;
  config.cookieSecure = false;

  const { openDatabase } = await import('../lib/db.js');
  const { createApp } = await import('../app.js');

  const db = options.db || openDatabase();
  const seeded = options.seed === false ? {} : seedData(db);

  const { app } = createApp({ db });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createClient(base);

  return {
    db,
    server,
    base,
    client,
    dir,
    ...seeded,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function pdfFile(name = 'doc.pdf', content = 'PDF-TEST-CONTENT') {
  return new File([Buffer.from(content)], name, { type: 'application/pdf' });
}

export function docForm(fields = {}) {
  const form = new FormData();
  form.append('type', fields.type || 'ППР');
  form.append('title', fields.title || 'Документ теста');
  form.append('status', fields.status || 'Черновик');
  if (fields.objectId) form.append('objectId', String(fields.objectId));
  if (fields.dueDate) form.append('dueDate', fields.dueDate);
  if (fields.responsible) form.append('responsible', fields.responsible);
  if (fields.cipher) form.append('cipher', fields.cipher);
  if (fields.content) form.append('content', fields.content);
  if (fields.file) form.append('docFile', fields.file);
  return form;
}
