// Централизованные миграции БД. Выполняются по порядку, ровно один раз,
// каждая — в транзакции. Повторный запуск безопасен.
import { taskMigration } from './tasks.js';
import { REMARK_STATUSES_DEFAULT } from '../constants.js';

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((row) => row.name === column);
}

function addColumn(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
}

function q(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const migrations = [
  {
    name: '001-base-schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS "Сотрудник" (
          "ID_сотрудника" INTEGER PRIMARY KEY AUTOINCREMENT,
          "Табельный_номер" TEXT NOT NULL UNIQUE,
          "Пароль" TEXT NOT NULL,
          "ФИО" TEXT NOT NULL,
          "Должность" TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "Виды_работ" (
          "ID_вида" INTEGER PRIMARY KEY AUTOINCREMENT,
          "Название" TEXT NOT NULL UNIQUE,
          "updated_at" DATETIME NOT NULL
        );

        CREATE TABLE IF NOT EXISTS "Работа" (
          "ID_работы" INTEGER PRIMARY KEY AUTOINCREMENT,
          "Название" TEXT NOT NULL,
          "ID_вида" INTEGER NOT NULL,
          "Описание" TEXT,
          "Инструкция" TEXT,
          "updated_at" DATETIME NOT NULL,
          FOREIGN KEY ("ID_вида") REFERENCES "Виды_работ"("ID_вида")
            ON DELETE RESTRICT ON UPDATE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "Статья" (
          "ID_статьи" INTEGER PRIMARY KEY AUTOINCREMENT,
          "Название" TEXT NOT NULL,
          "ID_работы" INTEGER NOT NULL,
          "Ключевые_слова" TEXT,
          "Дата_публикации" TEXT NOT NULL,
          "ID_автора" INTEGER NOT NULL,
          "Текст_статьи" TEXT NOT NULL,
          "Файл" TEXT,
          "updated_at" DATETIME NOT NULL,
          FOREIGN KEY ("ID_работы") REFERENCES "Работа"("ID_работы")
            ON DELETE RESTRICT ON UPDATE CASCADE,
          FOREIGN KEY ("ID_автора") REFERENCES "Сотрудник"("ID_сотрудника")
            ON DELETE RESTRICT ON UPDATE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_Работа_ID_вида ON "Работа"("ID_вида");
        CREATE INDEX IF NOT EXISTS idx_Статья_ID_работы ON "Статья"("ID_работы");
        CREATE INDEX IF NOT EXISTS idx_Статья_ID_автора ON "Статья"("ID_автора");
      `);
    }
  },
  {
    name: '002-pto-module',
    up(db) {
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
    }
  },
  {
    name: '003-security-and-access',
    up(db) {
      addColumn(db, 'Сотрудник', 'Демо', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'Сотрудник', 'Пароль_обновлён', 'TEXT');
      addColumn(db, 'Сотрудник', 'Заблокирован', 'INTEGER NOT NULL DEFAULT 0');

      addColumn(db, 'Статья', 'Оригинальное_имя', 'TEXT');
      addColumn(db, 'Статья', 'Размер', 'INTEGER');
      addColumn(db, 'Статья', 'MIME', 'TEXT');

      addColumn(db, 'Документ_ПТО', 'Оригинальное_имя', 'TEXT');
      addColumn(db, 'Документ_ПТО', 'Размер', 'INTEGER');
      addColumn(db, 'Документ_ПТО', 'MIME', 'TEXT');
      addColumn(db, 'Документ_ПТО', 'Текст_извлечён', 'TEXT');
      addColumn(db, 'Документ_ПТО', 'Требуется_OCR', 'INTEGER NOT NULL DEFAULT 0');

      db.exec(`
        CREATE TABLE IF NOT EXISTS "Сессия" (
          "sid" TEXT PRIMARY KEY,
          "sess" TEXT NOT NULL,
          "expires" INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_Сессия_expires ON "Сессия"("expires");

        CREATE TABLE IF NOT EXISTS "Аудит" (
          "ID_записи" INTEGER PRIMARY KEY AUTOINCREMENT,
          "Дата" TEXT NOT NULL,
          "ID_сотрудника" INTEGER,
          "ФИО" TEXT,
          "Действие" TEXT NOT NULL,
          "Сущность" TEXT,
          "ID_сущности" INTEGER,
          "ID_объекта" INTEGER,
          "Результат" TEXT NOT NULL,
          "IP" TEXT,
          "Детали" TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_Аудит_дата ON "Аудит"("Дата");
        CREATE INDEX IF NOT EXISTS idx_Аудит_сотрудник ON "Аудит"("ID_сотрудника");
        CREATE INDEX IF NOT EXISTS idx_Аудит_объект ON "Аудит"("ID_объекта");

        CREATE TABLE IF NOT EXISTS "Доступ_объект" (
          "ID_сотрудника" INTEGER NOT NULL,
          "ID_объекта" INTEGER NOT NULL,
          PRIMARY KEY ("ID_сотрудника", "ID_объекта"),
          FOREIGN KEY ("ID_сотрудника") REFERENCES "Сотрудник"("ID_сотрудника") ON DELETE CASCADE,
          FOREIGN KEY ("ID_объекта") REFERENCES "Объект"("ID_объекта") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "Редакция_ПТО" (
          "ID_редакции" INTEGER PRIMARY KEY AUTOINCREMENT,
          "ID_документа" INTEGER NOT NULL,
          "Версия" INTEGER NOT NULL,
          "Файл" TEXT,
          "Оригинальное_имя" TEXT,
          "Размер" INTEGER,
          "MIME" TEXT,
          "Комментарий" TEXT,
          "Автор" TEXT,
          "Создано" TEXT NOT NULL,
          FOREIGN KEY ("ID_документа") REFERENCES "Документ_ПТО"("ID_документа") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_Редакция_документ ON "Редакция_ПТО"("ID_документа");
      `);
    }
  },
  {
    name: '004-pto-completeness-remarks-notifications',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS "Комплект" (
          "ID_комплекта" INTEGER PRIMARY KEY AUTOINCREMENT,
          "Название" TEXT NOT NULL,
          "ID_объекта" INTEGER,
          "Ответственный" TEXT,
          "Примечание" TEXT,
          "Активен" INTEGER NOT NULL DEFAULT 1,
          "Создано" TEXT NOT NULL,
          "updated_at" TEXT NOT NULL,
          FOREIGN KEY ("ID_объекта") REFERENCES "Объект"("ID_объекта") ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS "Требование_комплекта" (
          "ID_требования" INTEGER PRIMARY KEY AUTOINCREMENT,
          "ID_комплекта" INTEGER NOT NULL,
          "Название" TEXT NOT NULL,
          "Тип_документа" TEXT,
          "Обязательно" INTEGER NOT NULL DEFAULT 1,
          "Порядок" INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY ("ID_комплекта") REFERENCES "Комплект"("ID_комплекта") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "Документ_комплекта" (
          "ID_связи" INTEGER PRIMARY KEY AUTOINCREMENT,
          "ID_требования" INTEGER NOT NULL,
          "ID_документа" INTEGER NOT NULL,
          "Создано" TEXT NOT NULL,
          UNIQUE ("ID_требования", "ID_документа"),
          FOREIGN KEY ("ID_требования") REFERENCES "Требование_комплекта"("ID_требования") ON DELETE CASCADE,
          FOREIGN KEY ("ID_документа") REFERENCES "Документ_ПТО"("ID_документа") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "Статус_замечания" (
          "Название" TEXT PRIMARY KEY,
          "Порядок" INTEGER NOT NULL DEFAULT 0,
          "Закрывающий" INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS "Замечание" (
          "ID_замечания" INTEGER PRIMARY KEY AUTOINCREMENT,
          "Номер" TEXT,
          "Дата" TEXT NOT NULL,
          "ID_объекта" INTEGER,
          "ID_документа" INTEGER,
          "Описание" TEXT NOT NULL,
          "Ответственный" TEXT,
          "ID_ответственного" INTEGER,
          "Срок" TEXT,
          "Статус" TEXT NOT NULL,
          "Дата_закрытия" TEXT,
          "ID_автора" INTEGER,
          "Создано" TEXT NOT NULL,
          "updated_at" TEXT NOT NULL,
          FOREIGN KEY ("ID_объекта") REFERENCES "Объект"("ID_объекта") ON DELETE SET NULL,
          FOREIGN KEY ("ID_документа") REFERENCES "Документ_ПТО"("ID_документа") ON DELETE SET NULL,
          FOREIGN KEY ("ID_ответственного") REFERENCES "Сотрудник"("ID_сотрудника") ON DELETE SET NULL,
          FOREIGN KEY ("ID_автора") REFERENCES "Сотрудник"("ID_сотрудника") ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_Замечание_объект ON "Замечание"("ID_объекта");
        CREATE INDEX IF NOT EXISTS idx_Замечание_статус ON "Замечание"("Статус");
        CREATE INDEX IF NOT EXISTS idx_Замечание_срок ON "Замечание"("Срок");

        CREATE TABLE IF NOT EXISTS "Комментарий_замечания" (
          "ID_комментария" INTEGER PRIMARY KEY AUTOINCREMENT,
          "ID_замечания" INTEGER NOT NULL,
          "Текст" TEXT NOT NULL,
          "Автор" TEXT,
          "Создано" TEXT NOT NULL,
          FOREIGN KEY ("ID_замечания") REFERENCES "Замечание"("ID_замечания") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "Вложение_замечания" (
          "ID_вложения" INTEGER PRIMARY KEY AUTOINCREMENT,
          "ID_замечания" INTEGER NOT NULL,
          "Файл" TEXT NOT NULL,
          "Оригинальное_имя" TEXT,
          "Размер" INTEGER,
          "MIME" TEXT,
          "Автор" TEXT,
          "Создано" TEXT NOT NULL,
          FOREIGN KEY ("ID_замечания") REFERENCES "Замечание"("ID_замечания") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "История_замечания" (
          "ID_записи" INTEGER PRIMARY KEY AUTOINCREMENT,
          "ID_замечания" INTEGER NOT NULL,
          "Дата" TEXT NOT NULL,
          "Автор" TEXT,
          "Действие" TEXT NOT NULL,
          "Статус_был" TEXT,
          "Статус_стал" TEXT,
          "Комментарий" TEXT,
          FOREIGN KEY ("ID_замечания") REFERENCES "Замечание"("ID_замечания") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS "Уведомление" (
          "ID_уведомления" INTEGER PRIMARY KEY AUTOINCREMENT,
          "ID_сотрудника" INTEGER NOT NULL,
          "Тип" TEXT NOT NULL,
          "Текст" TEXT NOT NULL,
          "Ссылка" TEXT,
          "Ключ" TEXT,
          "Прочитано" INTEGER NOT NULL DEFAULT 0,
          "Создано" TEXT NOT NULL,
          UNIQUE ("ID_сотрудника", "Ключ"),
          FOREIGN KEY ("ID_сотрудника") REFERENCES "Сотрудник"("ID_сотрудника") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_Уведомление_сотрудник ON "Уведомление"("ID_сотрудника", "Прочитано");
      `);

      const insertStatus = db.prepare('INSERT OR IGNORE INTO "Статус_замечания" ("Название", "Порядок", "Закрывающий") VALUES (?, ?, ?)');
      REMARK_STATUSES_DEFAULT.forEach((status, index) => {
        insertStatus.run(status, index, ['Закрыто', 'Отклонено', 'Устранено'].includes(status) ? 1 : 0);
      });
    }
  },
  {
    name: '005-search-index',
    up(db) {
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS "Поиск" USING fts5(
            "Тип" UNINDEXED,
            "ID" UNINDEXED,
            "ID_объекта" UNINDEXED,
            "Заголовок",
            "Дополнительно",
            "Текст",
            tokenize = 'unicode61 remove_diacritics 2'
          );
        `);
      } catch (error) {
        // Сборка SQLite без FTS5: поиск продолжит работать в режиме LIKE.
        db.__ftsUnavailable = true;
      }
    }
  },
  {
    name: '006-backfill-access-demo-and-revisions',
    up(db) {
      // Доступ к объектам для существующих сотрудников: сохраняем прежнее поведение
      // (все видели все объекты), после миграции доступ можно сузить в интерфейсе.
      const employees = db.prepare('SELECT "ID_сотрудника" FROM "Сотрудник"').all();
      const objects = db.prepare('SELECT "ID_объекта" FROM "Объект"').all();
      const grant = db.prepare('INSERT OR IGNORE INTO "Доступ_объект" ("ID_сотрудника", "ID_объекта") VALUES (?, ?)');

      for (const employee of employees) {
        for (const object of objects) {
          grant.run(employee.ID_сотрудника, object.ID_объекта);
        }
      }

      // Демонстрационные учётные записи помечаются, чтобы в production вход по ним был закрыт.
      db.prepare(`
        UPDATE "Сотрудник" SET "Демо" = 1
        WHERE "Табельный_номер" IN ('ADM002', 'SM002', 'M002', 'PTO01')
      `).run();

      // Начальные редакции для уже загруженных файлов документов ПТО.
      const docs = db.prepare(`
        SELECT d."ID_документа" as id, d."Файл" as file, d."Версия" as version,
               d."Актуализирован" as actualized, d."Ответственный" as responsible,
               d."Оригинальное_имя" as originalName
        FROM "Документ_ПТО" d
        WHERE d."Файл" IS NOT NULL AND d."Файл" <> ''
          AND NOT EXISTS (SELECT 1 FROM "Редакция_ПТО" r WHERE r."ID_документа" = d."ID_документа")
      `).all();

      const insertRevision = db.prepare(`
        INSERT INTO "Редакция_ПТО"
          ("ID_документа", "Версия", "Файл", "Оригинальное_имя", "Размер", "MIME", "Комментарий", "Автор", "Создано")
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      `);

      for (const doc of docs) {
        insertRevision.run(
          doc.id,
          doc.version || 1,
          doc.file,
          doc.originalName || String(doc.file).split('/').pop(),
          'Начальная редакция (перенесена из карточки документа)',
          doc.responsible || null,
          `${doc.actualized || ''} 00:00:00`
        );
      }
    }
  },
  taskMigration,
  { name: '008-document-operations', up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS Операция_документа (
      employee INTEGER NOT NULL, token TEXT NOT NULL, document INTEGER NOT NULL REFERENCES Документ_ПТО(ID_документа) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(employee,token)
    )`);
  } },
  { name: '009-optional-task-assignee', up(db) {
    db.exec('ALTER TABLE Задача ALTER COLUMN assigneeId DROP NOT NULL');
  } }
];

export function runMigrations(db, { logger } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "Миграции" (
      "ID" INTEGER PRIMARY KEY AUTOINCREMENT,
      "Название" TEXT NOT NULL UNIQUE,
      "Применена" TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT "Название" FROM "Миграции"').all();
  const applied = new Set(appliedRows.map((row) => row.Название));
  const record = db.prepare('INSERT INTO "Миграции" ("Название", "Применена") VALUES (?, datetime(\'now\', \'localtime\'))');

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      record.run(migration.name);
    });

    apply();

    if (logger) logger.info('Применена миграция', { name: migration.name });
  }

  return { appliedCount: migrations.filter((m) => !applied.has(m.name)).length, total: migrations.length };
}

export { migrations, hasTable, hasColumn };
export default runMigrations;
