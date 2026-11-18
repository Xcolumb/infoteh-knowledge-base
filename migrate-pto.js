import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'infoteh.db');

if (!fs.existsSync(dbPath)) {
  console.error(`База infoteh.db не найдена: ${dbPath}`);
  console.error('Сначала выполните: npm run seed');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

console.log('Миграция базы под модуль ПТО');
console.log(`Путь к БД: ${dbPath}`);
console.log('');

// Схема модуля ПТО. Все операции идемпотентны: повторный запуск безопасен.
db.exec(`
  CREATE TABLE IF NOT EXISTS "Объект" (
    "ID_объекта" INTEGER PRIMARY KEY AUTOINCREMENT,
    "Название" TEXT NOT NULL UNIQUE,
    "Адрес" TEXT,
    "Заказчик" TEXT,
    "updated_at" DATETIME NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "Документ_ПТО" (
    "ID_документа" INTEGER PRIMARY KEY AUTOINCREMENT,
    "Тип" TEXT NOT NULL,
    "Название" TEXT NOT NULL,
    "ID_объекта" INTEGER,
    "Шифр" TEXT,
    "Раздел_проекта" TEXT,
    "Статус" TEXT NOT NULL DEFAULT 'Черновик',
    "Срок" TEXT,
    "Ответственный" TEXT,
    "Текст" TEXT,
    "Файл" TEXT,
    "ID_автора" INTEGER,
    "Версия" INTEGER NOT NULL DEFAULT 1,
    "Актуализирован" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,
    FOREIGN KEY ("ID_объекта") REFERENCES "Объект"("ID_объекта")
      ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("ID_автора") REFERENCES "Сотрудник"("ID_сотрудника")
      ON DELETE SET NULL ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS "История_ПТО" (
    "ID_записи" INTEGER PRIMARY KEY AUTOINCREMENT,
    "ID_документа" INTEGER NOT NULL,
    "Дата" DATETIME NOT NULL,
    "Автор" TEXT,
    "Действие" TEXT NOT NULL,
    "Статус_был" TEXT,
    "Статус_стал" TEXT,
    "Версия" INTEGER,
    "Комментарий" TEXT,
    FOREIGN KEY ("ID_документа") REFERENCES "Документ_ПТО"("ID_документа")
      ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_Документ_ПТО_объект ON "Документ_ПТО"("ID_объекта");
  CREATE INDEX IF NOT EXISTS idx_Документ_ПТО_тип ON "Документ_ПТО"("Тип");
  CREATE INDEX IF NOT EXISTS idx_Документ_ПТО_статус ON "Документ_ПТО"("Статус");
  CREATE INDEX IF NOT EXISTS idx_История_ПТО_документ ON "История_ПТО"("ID_документа");
`);

const pad = (value) => String(value).padStart(2, '0');

function dateOnly(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dateTime(daysAgo, hour = 10, minute = 0) {
  return `${dateOnly(daysAgo)} ${pad(hour)}:${pad(minute)}:00`;
}

// === Сотрудник ПТО =========================================================

const ptoTabNumber = 'PTO01';
const ptoExists = db
  .prepare('SELECT "ID_сотрудника" FROM "Сотрудник" WHERE "Табельный_номер" = ?')
  .get(ptoTabNumber);

let ptoUserId;

if (ptoExists) {
  ptoUserId = ptoExists.ID_сотрудника;
  console.log(`Сотрудник ${ptoTabNumber} уже существует (ID ${ptoUserId})`);
} else {
  const result = db
    .prepare(`
      INSERT INTO "Сотрудник" ("Табельный_номер", "Пароль", "ФИО", "Должность")
      VALUES (?, ?, ?, ?)
    `)
    .run(ptoTabNumber, bcrypt.hashSync('pto123', 10), 'Соколов Дмитрий Андреевич', 'Инженер ПТО');
  ptoUserId = result.lastInsertRowid;
  console.log(`Добавлен сотрудник ПТО: Соколов Дмитрий Андреевич (${ptoTabNumber} / pto123)`);
}

const admin = db.prepare('SELECT "ID_сотрудника" FROM "Сотрудник" WHERE "Должность" = ?').get('Администратор');
const adminId = admin ? admin.ID_сотрудника : ptoUserId;

// === Объекты ===============================================================

const objects = [
  {
    name: 'ЖК «Солнечный», 2-я очередь',
    address: 'г. Балаково, ул. Степная, 12',
    customer: 'ООО «Балаково-Строй»'
  },
  {
    name: 'Школа на 1100 мест',
    address: 'г. Балаково, 6-й микрорайон, уч. 3',
    customer: 'МАОУ «СОШ № 5»'
  },
  {
    name: 'Балаковская ТЭЦ — ремонт цеха',
    address: 'г. Балаково, ул. Промышленная, 1',
    customer: 'ПАО «Балаковская ТЭЦ»'
  }
];

const objectIds = new Map();
const insertObject = db.prepare(`
  INSERT OR IGNORE INTO "Объект" ("Название", "Адрес", "Заказчик", "updated_at")
  VALUES (?, ?, ?, datetime('now', 'localtime'))
`);
const selectObject = db.prepare('SELECT "ID_объекта" FROM "Объект" WHERE "Название" = ?');

for (const object of objects) {
  insertObject.run(object.name, object.address, object.customer);
  objectIds.set(object.name, selectObject.get(object.name).ID_объекта);
}

// === Демонстрационные документы ============================================

const docCount = db.prepare('SELECT COUNT(*) as count FROM "Документ_ПТО"').get().count;

if (docCount > 0) {
  console.log(`В таблице «Документ_ПТО» уже ${docCount} записей — демо-данные не добавляются.`);
} else {
  const insertDoc = db.prepare(`
    INSERT INTO "Документ_ПТО" (
      "Тип", "Название", "ID_объекта", "Шифр", "Раздел_проекта", "Статус",
      "Срок", "Ответственный", "Текст", "Файл", "ID_автора", "Версия",
      "Актуализирован", "updated_at"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertHistory = db.prepare(`
    INSERT INTO "История_ПТО" (
      "ID_документа", "Дата", "Автор", "Действие",
      "Статус_был", "Статус_стал", "Версия", "Комментарий"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const docs = [
    {
      type: 'Исполнительная документация',
      title: 'Исполнительная документация по системе вентиляции и кондиционирования',
      object: 'ЖК «Солнечный», 2-я очередь',
      cipher: '2026-ИД-01',
      section: 'ОВ',
      status: 'На согласовании',
      due: dateOnly(-10),
      responsible: 'Соколов Дмитрий Андреевич',
      text: 'Комплект ИД по монтажу приточно-вытяжной вентиляции: акты освидетельствования, исполнительные схемы воздуховодов, протоколы пусконаладки. Требуется согласование с заказчиком.',
      author: ptoUserId,
      version: 2,
      history: [
        { daysAgo: 21, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: 'Загружен первичный комплект ИД.' },
        { daysAgo: 14, author: 'Соколов Дмитрий Андреевич', action: 'Новая редакция', was: null, became: null, version: 2, comment: 'Добавлены протоколы пусконаладочных работ.' },
        { daysAgo: 6, author: 'Соколов Дмитрий Андреевич', action: 'Смена статуса', was: 'Черновик', became: 'На согласовании', version: 2, comment: 'Передано заказчику на проверку.' }
      ]
    },
    {
      type: 'Исполнительная документация',
      title: 'Исполнительная документация по электроснабжению здания',
      object: 'Школа на 1100 мест',
      cipher: '2026-ИД-02',
      section: 'ЭОМ',
      status: 'Утверждён',
      due: dateOnly(5),
      responsible: 'Соколов Дмитрий Андреевич',
      text: 'ИД по наружному и внутреннему электроснабжению: кабельные журналы, исполнительные схемы щитов, протоколы измерений сопротивления изоляции.',
      author: ptoUserId,
      version: 3,
      history: [
        { daysAgo: 40, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: '' },
        { daysAgo: 30, author: 'Соколов Дмитрий Андреевич', action: 'Смена статуса', was: 'Черновик', became: 'На проверке', version: 1, comment: 'Комплект передан на нормоконтроль.' },
        { daysAgo: 18, author: 'Волкова Елена Игоревна', action: 'Смена статуса', was: 'На проверке', became: 'На согласовании', version: 2, comment: 'Замечания устранены, добавлены протоколы измерений.' },
        { daysAgo: 9, author: 'Соколов Дмитрий Андреевич', action: 'Смена статуса', was: 'На согласовании', became: 'Утверждён', version: 3, comment: 'Утверждено главным инженером проекта.' }
      ]
    },
    {
      type: 'ППР',
      title: 'ППР на монтаж технологического оборудования',
      object: 'Балаковская ТЭЦ — ремонт цеха',
      cipher: '2026-ППР-03',
      section: 'ТХ',
      status: 'Черновик',
      due: dateOnly(-20),
      responsible: 'Орлов Максим Сергеевич',
      text: 'Проект производства работ: последовательность монтажа, схемы строповки, требования охраны труда, график поставки оборудования.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 8, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: 'Черновик ППР, ожидается раздел по строповке.' }
      ]
    },
    {
      type: 'ППР',
      title: 'ППР на устройство котлована под фундамент',
      object: 'ЖК «Солнечный», 2-я очередь',
      cipher: '2026-ППР-04',
      section: 'КЖ',
      status: 'На проверке',
      due: dateOnly(3),
      responsible: 'Орлов Максим Сергеевич',
      text: 'ППР на земляные работы: крепление стенок котлована, водоотведение, расчёт откосов, схема движения техники.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 12, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: '' },
        { daysAgo: 4, author: 'Соколов Дмитрий Андреевич', action: 'Смена статуса', was: 'Черновик', became: 'На проверке', version: 1, comment: 'Направлено на проверку главному инженеру.' }
      ]
    },
    {
      type: 'Акт скрытых работ',
      title: 'АОСР: армирование фундаментной плиты',
      object: 'Школа на 1100 мест',
      cipher: '2026-АОСР-05',
      section: 'КЖ',
      status: 'Утверждён',
      due: dateOnly(7),
      responsible: 'Соколов Дмитрий Андреевич',
      text: 'Акт освидетельствования скрытых работ по армированию фундаментной плиты: приложены сертификаты на арматуру, исполнительная схема, результаты испытаний бетона.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 26, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: '' },
        { daysAgo: 22, author: 'Волкова Елена Игоревна', action: 'Смена статуса', was: 'Черновик', became: 'Утверждён', version: 1, comment: 'Подписан представителем технадзора заказчика.' }
      ]
    },
    {
      type: 'Акт скрытых работ',
      title: 'АОСР: прокладка кабеля в траншее',
      object: 'ЖК «Солнечный», 2-я очередь',
      cipher: '2026-АОСР-06',
      section: 'ЭС',
      status: 'Черновик',
      due: dateOnly(-5),
      responsible: 'Соколов Дмитрий Андреевич',
      text: 'Акт скрытых работ по прокладке кабеля 0,4 кВ в траншее. Нужны исполнительная схема трассы и протокол прогрева кабеля.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 3, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: 'Ожидается исполнительная схема от участка.' }
      ]
    },
    {
      type: 'Журнал работ',
      title: 'Общий журнал работ № 1',
      object: 'ЖК «Солнечный», 2-я очередь',
      cipher: '2026-ЖР-07',
      section: '—',
      status: 'Утверждён',
      due: dateOnly(15),
      responsible: 'Орлов Максим Сергеевич',
      text: 'Общий журнал работ по объекту: записи о выполнении монтажных работ, смене бригад, замечаниях технадзора.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 50, author: 'Орлов Максим Сергеевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: '' },
        { daysAgo: 45, author: 'Соколов Дмитрий Андреевич', action: 'Смена статуса', was: 'Черновик', became: 'Утверждён', version: 1, comment: 'Журнал прошнурован и зарегистрирован.' }
      ]
    },
    {
      type: 'Входной контроль',
      title: 'Входной контроль кабельной продукции',
      object: 'Школа на 1100 мест',
      cipher: '2026-ВК-08',
      section: 'ЭОМ',
      status: 'На согласовании',
      due: dateOnly(-2),
      responsible: 'Соколов Дмитрий Андреевич',
      text: 'Протокол входного контроля кабеля ВВГнг-LS: проверка маркировки, комплектности, сертификатов соответствия и целостности барабанов.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 7, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: '' },
        { daysAgo: 5, author: 'Соколов Дмитрий Андреевич', action: 'Смена статуса', was: 'Черновик', became: 'На согласовании', version: 1, comment: 'Передано снабжению для сверки с заявкой.' }
      ]
    },
    {
      type: 'Входной контроль',
      title: 'Входной контроль вентиляционного оборудования',
      object: 'Балаковская ТЭЦ — ремонт цеха',
      cipher: '2026-ВК-09',
      section: 'ОВ',
      status: 'Отклонён',
      due: dateOnly(4),
      responsible: 'Соколов Дмитрий Андреевич',
      text: 'Входной контроль приточных установок. Выявлены расхождения по комплектации фильтров и отсутствие паспорта на калорифер.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 11, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Черновик', version: 1, comment: '' },
        { daysAgo: 6, author: 'Волкова Елена Игоревна', action: 'Смена статуса', was: 'На согласовании', became: 'Отклонён', version: 1, comment: 'Не предоставлен паспорт на калорифер, комплектация не соответствует спецификации.' }
      ]
    },
    {
      type: 'Исполнительная документация',
      title: 'Исполнительная схема прокладки трубопроводов отопления',
      object: 'ЖК «Солнечный», 2-я очередь',
      cipher: '2026-ИД-10',
      section: 'ВК',
      status: 'В архиве',
      due: dateOnly(60),
      responsible: 'Соколов Дмитрий Андреевич',
      text: 'Исполнительная схема по системе отопления. Работы по объекту закрыты, комплект передан в архив.',
      author: ptoUserId,
      version: 1,
      history: [
        { daysAgo: 90, author: 'Соколов Дмитрий Андреевич', action: 'Создан', was: null, became: 'Утверждён', version: 1, comment: '' },
        { daysAgo: 60, author: 'Волкова Елена Игоревна', action: 'Смена статуса', was: 'Утверждён', became: 'В архиве', version: 1, comment: 'Объект сдан, документация передана в архив.' }
      ]
    }
  ];

  const insertAll = db.transaction(() => {
    for (const doc of docs) {
      const lastEntry = doc.history.length ? doc.history[doc.history.length - 1] : null;
      const result = insertDoc.run(
        doc.type,
        doc.title,
        objectIds.get(doc.object) ?? null,
        doc.cipher,
        doc.section,
        doc.status,
        doc.due,
        doc.responsible,
        doc.text,
        null,
        doc.author,
        doc.version,
        dateOnly(lastEntry ? lastEntry.daysAgo : 0),
        dateTime(lastEntry ? lastEntry.daysAgo : 0, 12, 0)
      );

      const docId = result.lastInsertRowid;

      for (const entry of doc.history) {
        insertHistory.run(
          docId,
          dateTime(entry.daysAgo, 10, 0),
          entry.author,
          entry.action,
          entry.was,
          entry.became,
          entry.version,
          entry.comment || null
        );
      }
    }
  });

  insertAll();
  console.log(`Добавлено демо-документов ПТО: ${docs.length}`);
  console.log(`Добавлено объектов: ${objects.length}`);
}

const totals = {
  objects: db.prepare('SELECT COUNT(*) as count FROM "Объект"').get().count,
  documents: db.prepare('SELECT COUNT(*) as count FROM "Документ_ПТО"').get().count,
  history: db.prepare('SELECT COUNT(*) as count FROM "История_ПТО"').get().count
};

console.log('');
console.log('Готово. Итоги:');
console.log(`  Объекты: ${totals.objects}`);
console.log(`  Документы ПТО: ${totals.documents}`);
console.log(`  Записи истории: ${totals.history}`);
console.log('');
console.log('Вход для проверки: табельный номер PTO01, пароль pto123');
console.log('Не забудьте обновить демо-данные в README.');

db.close();
