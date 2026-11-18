import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import crypto from 'crypto';
import session from 'express-session';
import bcrypt from 'bcryptjs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = 3001;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log('Создана папка uploads/');
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только PDF-файлы'), false);
    }
  }
});

// Файлы документов ПТО: кроме PDF допускаем офисные форматы,
// потому что ППР, акты и журналы обычно готовят в Word и Excel.
const DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];

const uploadDoc = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DOC_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены файлы PDF, DOC, DOCX, XLS, XLSX'), false);
    }
  }
});

function removeFileQuietly(filePath) {
  if (!filePath) return;

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Не удалось удалить файл:', filePath, error.message);
  }
}

app.use(cors());
app.use(express.json());

// Секрет генерируется при каждом старте, если не задан SESSION_SECRET.
// Это означает, что после перезапуска сервера все сессии сбрасываются.
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  name: 'infoteh.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // Для локального HTTP. За HTTPS-прокси включите secure: true и trust proxy.
    secure: false,
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, 'frontend-html')));
app.use('/uploads', express.static(uploadsDir));

const dbPath = path.join(__dirname, 'infoteh.db');
let db;

try {
  db = new Database(dbPath, { readonly: false });
  db.pragma('foreign_keys = ON');
  console.log('Подключение к БД infoteh.db установлено');
  console.log(`Путь к БД: ${dbPath}`);
} catch (error) {
  console.error('Ошибка подключения к БД:', error.message);
  console.log('');
  console.log('Убедитесь, что файл infoteh.db находится в корневой папке проекта.');
  console.log('Положите файл сюда: ' + dbPath);
  process.exit(1);
}

const getEmployeeAuthStmt = db.prepare(`
  SELECT "Должность" as role, "ФИО" as fullName
  FROM "Сотрудник"
  WHERE "ID_сотрудника" = ?
`);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      success: false,
      error: 'Требуется авторизация'
    });
  }

  // Роль берём из БД, а не только из сессии: так удалённый сотрудник
  // или сотрудник с изменённой должностью теряет доступ сразу.
  const employee = getEmployeeAuthStmt.get(req.session.userId);

  if (!employee) {
    return req.session.destroy(() => {
      res.status(401).json({
        success: false,
        error: 'Сессия недействительна, войдите заново'
      });
    });
  }

  req.session.role = employee.role;
  req.session.fullName = employee.fullName;
  next();
}

function requireRole(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];

  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({
        success: false,
        error: 'Требуется авторизация'
      });
    }

    if (!allowedRoles.includes(req.session.role)) {
      return res.status(403).json({
        success: false,
        error: 'Недостаточно прав для этого действия'
      });
    }

    next();
  };
}

const ADMIN_ONLY = ['Администратор'];
const CONTENT_MANAGERS = ['Администратор', 'Старший монтажник'];
const PTO_MANAGERS = ['Администратор', 'Инженер ПТО'];

const ROLES = ['Монтажник', 'Старший монтажник', 'Инженер ПТО', 'Администратор'];

const PTO_TYPES = [
  'Исполнительная документация',
  'ППР',
  'Акт скрытых работ',
  'Журнал работ',
  'Входной контроль'
];

const PTO_STATUSES = [
  'Черновик',
  'На проверке',
  'На согласовании',
  'Утверждён',
  'Отклонён',
  'В архиве'
];

// Схема модуля ПТО создаётся при старте, если её ещё нет:
// так модуль работает и без отдельного запуска migrate-pto.js.
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

app.post('/api/auth/login', async (req, res) => {
  const { tabNumber, password } = req.body || {};

  if (!tabNumber || !password) {
    return res.status(400).json({
      success: false,
      error: 'Введите табельный номер и пароль'
    });
  }

  try {
    const stmt = db.prepare(`
      SELECT
        "ID_сотрудника" as id,
        "Табельный_номер" as tabNumber,
        "ФИО" as fullName,
        "Должность" as role,
        "Пароль" as passwordHash
      FROM "Сотрудник"
      WHERE "Табельный_номер" = ?
    `);

    const row = stmt.get(tabNumber);
    const passwordMatches = row ? await bcrypt.compare(password, row.passwordHash) : false;

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        error: 'Неверный табельный номер или пароль'
      });
    }

    const { passwordHash, ...user } = row;

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.fullName = user.fullName;

    console.log(`Авторизация: ${user.fullName} (${user.role})`);

    req.session.save((error) => {
      if (error) {
        console.error('Ошибка сохранения сессии:', error);
        return res.status(500).json({ success: false, error: 'Ошибка сервера' });
      }

      res.json({ success: true, user });
    });
  } catch (error) {
    console.error('Ошибка авторизации:', error);
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// Все маршруты /api ниже этой строки требуют активной сессии.
// Логин объявлен выше и поэтому остаётся публичным.
app.use('/api', requireAuth);

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error('Ошибка выхода:', error);
      return res.status(500).json({ success: false, error: 'Не удалось завершить сессию' });
    }

    res.clearCookie('infoteh.sid');
    res.json({ success: true });
  });
});

app.get('/api/sotrudniki', requireRole(ADMIN_ONLY), (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT 
        "ID_сотрудника" as id,
        "Табельный_номер" as tabNumber,
        "ФИО" as fullName,
        "Должность" as role
      FROM "Сотрудник" 
      ORDER BY "ID_сотрудника"
    `);
    res.json({ success: true, data: stmt.all() });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/sotrudniki', requireRole(ADMIN_ONLY), async (req, res) => {
  const { tabNumber, password, fullName, role } = req.body;

  if (!tabNumber || !password || !fullName || !role) {
    return res.status(400).json({ success: false, error: 'Заполните все поля' });
  }

  if (!ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: 'Недопустимая должность' });
  }

  try {
    const checkStmt = db.prepare('SELECT "ID_сотрудника" FROM "Сотрудник" WHERE "Табельный_номер" = ?');
    if (checkStmt.get(tabNumber)) {
      return res.status(400).json({ success: false, error: 'Сотрудник с таким табельным номером уже существует' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const stmt = db.prepare(`
      INSERT INTO "Сотрудник" ("Табельный_номер", "Пароль", "ФИО", "Должность") 
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(tabNumber, passwordHash, fullName, role);

    console.log(`Добавлен сотрудник: ${fullName} (${role})`);

    res.json({
      success: true,
      data: { id: result.lastInsertRowid, tabNumber, fullName, role }
    });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/sotrudniki/:id/role', requireRole(ADMIN_ONLY), (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  const validRoles = ROLES;
  if (!validRoles.includes(role)) {
    return res.status(400).json({ success: false, error: 'Недопустимая должность' });
  }

  try {
    const stmt = db.prepare('UPDATE "Сотрудник" SET "Должность" = ? WHERE "ID_сотрудника" = ?');
    const result = stmt.run(role, id);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
    }

    console.log(`Изменена должность сотрудника #${id}: ${role}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/sotrudniki/:id', requireRole(ADMIN_ONLY), (req, res) => {
  const { id } = req.params;

  try {
    const stmt = db.prepare('DELETE FROM "Сотрудник" WHERE "ID_сотрудника" = ?');
    const result = stmt.run(id);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Сотрудник не найден' });
    }

    console.log(`Удалён сотрудник #${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/vidy-rabot', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT "ID_вида" as id, "Название" as name, "updated_at" as updatedAt
      FROM "Виды_работ" ORDER BY "ID_вида"
    `);
    res.json({ success: true, data: stmt.all() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/vidy-rabot', requireRole(CONTENT_MANAGERS), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Введите название' });
  try {
    const stmt = db.prepare(`
      INSERT INTO "Виды_работ" ("Название", "updated_at")
      VALUES (?, datetime('now', 'localtime'))
    `);
    const result = stmt.run(name.trim());
    console.log(`Добавлен вид работ: ${name}`);
    res.json({ success: true, data: { id: result.lastInsertRowid, name: name.trim() } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, error: 'Вид работ с таким названием уже существует' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/vidy-rabot/:id', requireRole(CONTENT_MANAGERS), (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Введите название' });

  try {
    const existing = db.prepare('SELECT "ID_вида" FROM "Виды_работ" WHERE "ID_вида" = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Вид работ не найден' });
    }

    db.prepare(`
      UPDATE "Виды_работ"
      SET "Название" = ?, "updated_at" = datetime('now', 'localtime')
      WHERE "ID_вида" = ?
    `).run(name.trim(), id);

    console.log(`Изменён вид работ #${id}: ${name.trim()}`);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, error: 'Вид работ с таким названием уже существует' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/vidy-rabot/:id', requireRole(CONTENT_MANAGERS), (req, res) => {
  const { id } = req.params;
  try {
    const checkStmt = db.prepare('SELECT COUNT(*) as count FROM "Работа" WHERE "ID_вида" = ?');
    const { count } = checkStmt.get(id);
    
    if (count > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Невозможно удалить: есть ${count} связанных работ` 
      });
    }
    const stmt = db.prepare('DELETE FROM "Виды_работ" WHERE "ID_вида" = ?');
    const result = stmt.run(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Вид работ не найден' });
    }
    console.log(`Удалён вид работ #${id}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/raboty', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT 
        r."ID_работы" as id,
        r."Название" as name,
        r."ID_вида" as vidId,
        v."Название" as vidName,
        r."Описание" as description,
        r."Инструкция" as instruction,
        r."updated_at" as updatedAt
      FROM "Работа" r
      LEFT JOIN "Виды_работ" v ON r."ID_вида" = v."ID_вида"
      ORDER BY r."ID_работы"
    `);
    res.json({ success: true, data: stmt.all() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/raboty', requireRole(CONTENT_MANAGERS), (req, res) => {
  const { name, vidId, description, instruction } = req.body;
  if (!name || !vidId) return res.status(400).json({ success: false, error: 'Заполните обязательные поля' });
  try {
    const vidExists = db.prepare('SELECT "ID_вида" FROM "Виды_работ" WHERE "ID_вида" = ?').get(vidId);
    if (!vidExists) {
      return res.status(400).json({ success: false, error: 'Вид работ не найден' });
    }

    const stmt = db.prepare(`
      INSERT INTO "Работа" ("Название", "ID_вида", "Описание", "Инструкция", "updated_at") 
      VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    `);
    const result = stmt.run(name, vidId, description || null, instruction || null);
    console.log(`Добавлена работа: ${name}`);
    res.json({ success: true, data: { id: result.lastInsertRowid, name, vidId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/raboty/:id', requireRole(CONTENT_MANAGERS), (req, res) => {
  const { id } = req.params;
  const { name, vidId, description, instruction } = req.body;
  if (!name || !vidId) return res.status(400).json({ success: false, error: 'Заполните обязательные поля' });

  try {
    const existing = db.prepare('SELECT "ID_работы" FROM "Работа" WHERE "ID_работы" = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Работа не найдена' });
    }

    const vidExists = db.prepare('SELECT "ID_вида" FROM "Виды_работ" WHERE "ID_вида" = ?').get(vidId);
    if (!vidExists) {
      return res.status(400).json({ success: false, error: 'Вид работ не найден' });
    }

    db.prepare(`
      UPDATE "Работа"
      SET "Название" = ?, "ID_вида" = ?, "Описание" = ?, "Инструкция" = ?,
          "updated_at" = datetime('now', 'localtime')
      WHERE "ID_работы" = ?
    `).run(name, vidId, description || null, instruction || null, id);

    console.log(`Изменена работа #${id}: ${name}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/raboty/:id', requireRole(CONTENT_MANAGERS), (req, res) => {
  const { id } = req.params;
  try {
    const checkStmt = db.prepare('SELECT COUNT(*) as count FROM "Статья" WHERE "ID_работы" = ?');
    const { count } = checkStmt.get(id);
    
    if (count > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Невозможно удалить: есть ${count} связанных статей` 
      });
    }
    const stmt = db.prepare('DELETE FROM "Работа" WHERE "ID_работы" = ?');
    const result = stmt.run(id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Работа не найдена' });
    }
    console.log(`Удалена работа #${id}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/articles', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT 
        s."ID_статьи" as id,
        s."Название" as title,
        s."ID_работы" as rabotaId,
        r."Название" as rabotaName,
        v."Название" as vidName,
        s."Ключевые_слова" as keywords,
        s."Дата_публикации" as publishDate,
        s."ID_автора" as authorId,
        sot."ФИО" as authorName,
        s."Текст_статьи" as content,
        s."Файл" as file,
        s."updated_at" as updatedAt
      FROM "Статья" s
      LEFT JOIN "Работа" r ON s."ID_работы" = r."ID_работы"
      LEFT JOIN "Виды_работ" v ON r."ID_вида" = v."ID_вида"
      LEFT JOIN "Сотрудник" sot ON s."ID_автора" = sot."ID_сотрудника"
      ORDER BY s."Дата_публикации" DESC
    `);
    res.json({ success: true, data: stmt.all() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/articles/:id', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT 
        s."ID_статьи" as id,
        s."Название" as title,
        s."ID_работы" as rabotaId,
        r."Название" as rabotaName,
        v."Название" as vidName,
        s."Ключевые_слова" as keywords,
        s."Дата_публикации" as publishDate,
        s."ID_автора" as authorId,
        sot."ФИО" as authorName,
        s."Текст_статьи" as content,
        s."Файл" as file,
        s."updated_at" as updatedAt
      FROM "Статья" s
      LEFT JOIN "Работа" r ON s."ID_работы" = r."ID_работы"
      LEFT JOIN "Виды_работ" v ON r."ID_вида" = v."ID_вида"
      LEFT JOIN "Сотрудник" sot ON s."ID_автора" = sot."ID_сотрудника"
      WHERE s."ID_статьи" = ?
    `);
    const article = stmt.get(req.params.id);

    if (!article) return res.status(404).json({ success: false, error: 'Статья не найдена' });
    res.json({ success: true, data: article });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/articles', requireRole(CONTENT_MANAGERS), upload.single('pdfFile'), (req, res) => {
  const { title, rabotaId, keywords, content } = req.body;
  if (!title || !rabotaId || !content) {
    removeFileQuietly(req.file && req.file.path);
    return res.status(400).json({ success: false, error: 'Заполните обязательные поля' });
  }
  try {
    const rabotaExists = db.prepare('SELECT "ID_работы" FROM "Работа" WHERE "ID_работы" = ?').get(rabotaId);
    if (!rabotaExists) {
      removeFileQuietly(req.file && req.file.path);
      return res.status(400).json({ success: false, error: 'Работа не найдена' });
    }

    const now = new Date();
    const publishDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-');
    const filePath = req.file ? `/uploads/${req.file.filename}` : null;
    const stmt = db.prepare(`
      INSERT INTO "Статья" (
        "Название", "ID_работы", "Ключевые_слова", 
        "Дата_публикации", "ID_автора", "Текст_статьи", "Файл", "updated_at"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);
    const result = stmt.run(title, rabotaId, keywords || null, publishDate, req.session.userId, content, filePath);
    console.log(`📝 Добавлена статья: "${title}"${filePath ? ' (с PDF)' : ''}`);
    res.json({ success: true, data: { id: result.lastInsertRowid, title, publishDate, filePath } });
  } catch (error) {
    removeFileQuietly(req.file && req.file.path);
    console.error('Ошибка добавления статьи:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/articles/:id', requireRole(CONTENT_MANAGERS), upload.single('pdfFile'), (req, res) => {
  const { id } = req.params;
  const { title, rabotaId, keywords, content } = req.body;

  if (!title || !rabotaId || !content) {
    removeFileQuietly(req.file && req.file.path);
    return res.status(400).json({ success: false, error: 'Заполните обязательные поля' });
  }

  try {
    const existing = db.prepare('SELECT "Файл" as file FROM "Статья" WHERE "ID_статьи" = ?').get(id);
    if (!existing) {
      removeFileQuietly(req.file && req.file.path);
      return res.status(404).json({ success: false, error: 'Статья не найдена' });
    }

    const rabotaExists = db.prepare('SELECT "ID_работы" FROM "Работа" WHERE "ID_работы" = ?').get(rabotaId);
    if (!rabotaExists) {
      removeFileQuietly(req.file && req.file.path);
      return res.status(400).json({ success: false, error: 'Работа не найдена' });
    }

    const newFile = req.file ? `/uploads/${req.file.filename}` : existing.file;

    db.prepare(`
      UPDATE "Статья"
      SET "Название" = ?, "ID_работы" = ?, "Ключевые_слова" = ?,
          "Текст_статьи" = ?, "Файл" = ?,
          "updated_at" = datetime('now', 'localtime')
      WHERE "ID_статьи" = ?
    `).run(title, rabotaId, keywords || null, content, newFile, id);

    if (req.file && existing.file && existing.file !== newFile) {
      removeFileQuietly(path.join(__dirname, existing.file));
      console.log(`Заменён файл статьи #${id}: ${existing.file} -> ${newFile}`);
    }

    console.log(`Изменена статья #${id}: "${title}"`);
    res.json({ success: true, data: { id: Number(id), file: newFile } });
  } catch (error) {
    removeFileQuietly(req.file && req.file.path);
    console.error('Ошибка редактирования статьи:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// === Модуль ПТО: объекты, документы, статусы, история ======================

const PTO_SELECT = `
  SELECT
    d."ID_документа" as id,
    d."Тип" as type,
    d."Название" as title,
    d."ID_объекта" as objectId,
    o."Название" as objectName,
    d."Шифр" as cipher,
    d."Раздел_проекта" as projectSection,
    d."Статус" as status,
    d."Срок" as dueDate,
    d."Ответственный" as responsible,
    d."Текст" as content,
    d."Файл" as file,
    d."ID_автора" as authorId,
    a."ФИО" as authorName,
    d."Версия" as version,
    d."Актуализирован" as actualizedAt,
    d."updated_at" as updatedAt
  FROM "Документ_ПТО" d
  LEFT JOIN "Объект" o ON d."ID_объекта" = o."ID_объекта"
  LEFT JOIN "Сотрудник" a ON d."ID_автора" = a."ID_сотрудника"
`;

function buildPtoFilters(req) {
  const conditions = [];
  const params = [];

  const type = String(req.query.type || '').trim();
  if (type && type !== 'all') {
    conditions.push('d."Тип" = ?');
    params.push(type);
  }

  const status = String(req.query.status || '').trim();
  if (status && status !== 'all') {
    conditions.push('d."Статус" = ?');
    params.push(status);
  }

  const objectId = String(req.query.objectId || '').trim();
  if (objectId && objectId !== 'all') {
    conditions.push('d."ID_объекта" = ?');
    params.push(Number(objectId));
  }

  const q = String(req.query.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(`(
      d."Название" LIKE ? OR
      COALESCE(d."Шифр", '') LIKE ? OR
      COALESCE(d."Раздел_проекта", '') LIKE ? OR
      COALESCE(o."Название", '') LIKE ? OR
      COALESCE(d."Ответственный", '') LIKE ?
    )`);
    params.push(like, like, like, like, like);
  }

  if (String(req.query.overdue || '') === '1') {
    conditions.push(`
      d."Срок" IS NOT NULL AND d."Срок" <> ''
      AND d."Срок" < date('now', 'localtime')
      AND d."Статус" NOT IN ('Утверждён', 'В архиве')
    `);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

function validatePtoFields(body) {
  const type = String(body.type || '').trim();
  const title = String(body.title || '').trim();
  const status = String(body.status || '').trim() || 'Черновик';
  const dueDate = String(body.dueDate || '').trim();
  const objectIdRaw = String(body.objectId || '').trim();

  if (!type || !PTO_TYPES.includes(type)) {
    return { error: 'Выберите тип документа' };
  }

  if (!title) {
    return { error: 'Введите название документа' };
  }

  if (!PTO_STATUSES.includes(status)) {
    return { error: 'Недопустимый статус документа' };
  }

  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { error: 'Срок указывается в формате ГГГГ-ММ-ДД' };
  }

  const objectId = objectIdRaw ? Number(objectIdRaw) : null;
  if (objectIdRaw && !Number.isInteger(objectId)) {
    return { error: 'Некорректный объект' };
  }

  return {
    fields: {
      type,
      title,
      status,
      dueDate: dueDate || null,
      objectId,
      cipher: String(body.cipher || '').trim() || null,
      projectSection: String(body.projectSection || '').trim() || null,
      responsible: String(body.responsible || '').trim() || null,
      content: String(body.content || '').trim() || null
    }
  };
}

function addPtoHistory(documentId, action, options = {}) {
  db.prepare(`
    INSERT INTO "История_ПТО" (
      "ID_документа", "Дата", "Автор", "Действие",
      "Статус_был", "Статус_стал", "Версия", "Комментарий"
    ) VALUES (?, datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?)
  `).run(
    documentId,
    options.author || null,
    action,
    options.statusFrom || null,
    options.statusTo || null,
    options.version ?? null,
    options.comment || null
  );
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// --- Объекты ---

app.get('/api/objects', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        o."ID_объекта" as id,
        o."Название" as name,
        o."Адрес" as address,
        o."Заказчик" as customer,
        o."updated_at" as updatedAt,
        (SELECT COUNT(*) FROM "Документ_ПТО" d WHERE d."ID_объекта" = o."ID_объекта") as documentsCount
      FROM "Объект" o
      ORDER BY o."Название"
    `).all();

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Ошибка загрузки объектов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/objects', requireRole(PTO_MANAGERS), (req, res) => {
  const name = String(req.body.name || '').trim();
  const address = String(req.body.address || '').trim() || null;
  const customer = String(req.body.customer || '').trim() || null;

  if (!name) {
    return res.status(400).json({ success: false, error: 'Введите название объекта' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO "Объект" ("Название", "Адрес", "Заказчик", "updated_at")
      VALUES (?, ?, ?, datetime('now', 'localtime'))
    `).run(name, address, customer);

    console.log(`Добавлен объект: ${name}`);
    res.json({ success: true, data: { id: result.lastInsertRowid, name, address, customer } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, error: 'Объект с таким названием уже существует' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/objects/:id', requireRole(PTO_MANAGERS), (req, res) => {
  const name = String(req.body.name || '').trim();
  const address = String(req.body.address || '').trim() || null;
  const customer = String(req.body.customer || '').trim() || null;

  if (!name) {
    return res.status(400).json({ success: false, error: 'Введите название объекта' });
  }

  try {
    const result = db.prepare(`
      UPDATE "Объект"
      SET "Название" = ?, "Адрес" = ?, "Заказчик" = ?, "updated_at" = datetime('now', 'localtime')
      WHERE "ID_объекта" = ?
    `).run(name, address, customer, req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Объект не найден' });
    }

    res.json({ success: true });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, error: 'Объект с таким названием уже существует' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/objects/:id', requireRole(PTO_MANAGERS), (req, res) => {
  try {
    const { count } = db
      .prepare('SELECT COUNT(*) as count FROM "Документ_ПТО" WHERE "ID_объекта" = ?')
      .get(req.params.id);

    if (count > 0) {
      return res.status(400).json({
        success: false,
        error: `Невозможно удалить: к объекту привязано ${count} документов`
      });
    }

    const result = db.prepare('DELETE FROM "Объект" WHERE "ID_объекта" = ?').run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Объект не найден' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Реестр документов (CSV) ---
// Объявлен до /api/pto/:id, иначе Express примет "export.csv" за идентификатор.

app.get('/api/pto/export.csv', (req, res) => {
  try {
    const { where, params } = buildPtoFilters(req);
    const rows = db.prepare(`
      ${PTO_SELECT}
      ${where}
      ORDER BY CASE WHEN d."Срок" IS NULL OR d."Срок" = '' THEN 1 ELSE 0 END, d."Срок", d."ID_документа"
    `).all(...params);

    const header = [
      '№', 'Тип документа', 'Наименование', 'Объект', 'Шифр', 'Раздел проекта',
      'Статус', 'Срок', 'Ответственный', 'Версия', 'Актуализирован', 'Обновлён', 'Файл'
    ];

    const lines = [header.map(csvCell).join(';')];

    rows.forEach((row, index) => {
      lines.push([
        index + 1,
        row.type,
        row.title,
        row.objectName || '',
        row.cipher || '',
        row.projectSection || '',
        row.status,
        row.dueDate || '',
        row.responsible || '',
        row.version,
        row.actualizedAt || '',
        row.updatedAt || '',
        row.file || ''
      ].map(csvCell).join(';'));
    });

    const fileName = `reestr-pto-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    // BOM нужен, чтобы Excel корректно открыл кириллицу.
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (error) {
    console.error('Ошибка выгрузки реестра ПТО:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Документы ПТО ---

app.get('/api/pto', (req, res) => {
  try {
    const { where, params } = buildPtoFilters(req);
    const rows = db.prepare(`
      ${PTO_SELECT}
      ${where}
      ORDER BY CASE WHEN d."Срок" IS NULL OR d."Срок" = '' THEN 1 ELSE 0 END, d."Срок", d."ID_документа"
    `).all(...params);

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Ошибка загрузки документов ПТО:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pto/:id', (req, res) => {
  try {
    const document = db.prepare(`${PTO_SELECT} WHERE d."ID_документа" = ?`).get(req.params.id);

    if (!document) {
      return res.status(404).json({ success: false, error: 'Документ не найден' });
    }

    const history = db.prepare(`
      SELECT
        "ID_записи" as id,
        "Дата" as date,
        "Автор" as author,
        "Действие" as action,
        "Статус_был" as statusFrom,
        "Статус_стал" as statusTo,
        "Версия" as version,
        "Комментарий" as comment
      FROM "История_ПТО"
      WHERE "ID_документа" = ?
      ORDER BY "Дата" DESC, "ID_записи" DESC
    `).all(req.params.id);

    res.json({ success: true, data: { ...document, history } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pto', requireRole(PTO_MANAGERS), uploadDoc.single('docFile'), (req, res) => {
  const { fields, error: validationError } = validatePtoFields(req.body);

  if (validationError) {
    removeFileQuietly(req.file && req.file.path);
    return res.status(400).json({ success: false, error: validationError });
  }

  try {
    if (fields.objectId) {
      const objectExists = db
        .prepare('SELECT "ID_объекта" FROM "Объект" WHERE "ID_объекта" = ?')
        .get(fields.objectId);

      if (!objectExists) {
        removeFileQuietly(req.file && req.file.path);
        return res.status(400).json({ success: false, error: 'Объект не найден' });
      }
    }

    const filePath = req.file ? `/uploads/${req.file.filename}` : null;

    const result = db.prepare(`
      INSERT INTO "Документ_ПТО" (
        "Тип", "Название", "ID_объекта", "Шифр", "Раздел_проекта", "Статус",
        "Срок", "Ответственный", "Текст", "Файл", "ID_автора", "Версия",
        "Актуализирован", "updated_at"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, date('now', 'localtime'), datetime('now', 'localtime'))
    `).run(
      fields.type,
      fields.title,
      fields.objectId,
      fields.cipher,
      fields.projectSection,
      fields.status,
      fields.dueDate,
      fields.responsible,
      fields.content,
      filePath,
      req.session.userId
    );

    addPtoHistory(result.lastInsertRowid, 'Создан', {
      author: req.session.fullName,
      statusTo: fields.status,
      version: 1,
      comment: req.body.comment || null
    });

    console.log(`📋 Добавлен документ ПТО: "${fields.title}" (${fields.type})`);
    res.json({ success: true, data: { id: result.lastInsertRowid } });
  } catch (error) {
    removeFileQuietly(req.file && req.file.path);
    console.error('Ошибка добавления документа ПТО:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/pto/:id', requireRole(PTO_MANAGERS), uploadDoc.single('docFile'), (req, res) => {
  const { fields, error: validationError } = validatePtoFields(req.body);

  if (validationError) {
    removeFileQuietly(req.file && req.file.path);
    return res.status(400).json({ success: false, error: validationError });
  }

  try {
    const existing = db.prepare(`
      SELECT "Статус" as status, "Файл" as file, "Версия" as version
      FROM "Документ_ПТО" WHERE "ID_документа" = ?
    `).get(req.params.id);

    if (!existing) {
      removeFileQuietly(req.file && req.file.path);
      return res.status(404).json({ success: false, error: 'Документ не найден' });
    }

    if (fields.objectId) {
      const objectExists = db
        .prepare('SELECT "ID_объекта" FROM "Объект" WHERE "ID_объекта" = ?')
        .get(fields.objectId);

      if (!objectExists) {
        removeFileQuietly(req.file && req.file.path);
        return res.status(400).json({ success: false, error: 'Объект не найден' });
      }
    }

    const newFile = req.file ? `/uploads/${req.file.filename}` : existing.file;
    const isNewRevision = Boolean(req.file) || String(req.body.newRevision || '') === 'true';
    const version = isNewRevision ? existing.version + 1 : existing.version;
    const statusChanged = existing.status !== fields.status;

    db.prepare(`
      UPDATE "Документ_ПТО"
      SET "Тип" = ?, "Название" = ?, "ID_объекта" = ?, "Шифр" = ?, "Раздел_проекта" = ?,
          "Статус" = ?, "Срок" = ?, "Ответственный" = ?, "Текст" = ?, "Файл" = ?,
          "Версия" = ?, "Актуализирован" = date('now', 'localtime'),
          "updated_at" = datetime('now', 'localtime')
      WHERE "ID_документа" = ?
    `).run(
      fields.type,
      fields.title,
      fields.objectId,
      fields.cipher,
      fields.projectSection,
      fields.status,
      fields.dueDate,
      fields.responsible,
      fields.content,
      newFile,
      version,
      req.params.id
    );

    if (req.file && existing.file && existing.file !== newFile) {
      removeFileQuietly(path.join(__dirname, existing.file));
    }

    if (statusChanged) {
      addPtoHistory(req.params.id, 'Смена статуса', {
        author: req.session.fullName,
        statusFrom: existing.status,
        statusTo: fields.status,
        version,
        comment: req.body.comment || null
      });
    }

    if (isNewRevision) {
      addPtoHistory(req.params.id, 'Новая редакция', {
        author: req.session.fullName,
        version,
        comment: req.file ? 'Заменён файл документа' : 'Отмечена новая редакция без замены файла'
      });
    }

    if (!statusChanged && !isNewRevision) {
      addPtoHistory(req.params.id, 'Изменён', {
        author: req.session.fullName,
        version
      });
    }

    console.log(`Изменён документ ПТО #${req.params.id}: "${fields.title}"`);
    res.json({ success: true, data: { id: Number(req.params.id), file: newFile, version } });
  } catch (error) {
    removeFileQuietly(req.file && req.file.path);
    console.error('Ошибка редактирования документа ПТО:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/pto/:id/status', requireRole(PTO_MANAGERS), (req, res) => {
  const status = String(req.body.status || '').trim();
  const comment = String(req.body.comment || '').trim() || null;

  if (!PTO_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, error: 'Недопустимый статус документа' });
  }

  try {
    const existing = db
      .prepare('SELECT "Статус" as status, "Версия" as version FROM "Документ_ПТО" WHERE "ID_документа" = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Документ не найден' });
    }

    if (existing.status === status) {
      return res.status(400).json({ success: false, error: 'Документ уже в этом статусе' });
    }

    db.prepare(`
      UPDATE "Документ_ПТО"
      SET "Статус" = ?, "Актуализирован" = date('now', 'localtime'),
          "updated_at" = datetime('now', 'localtime')
      WHERE "ID_документа" = ?
    `).run(status, req.params.id);

    addPtoHistory(req.params.id, 'Смена статуса', {
      author: req.session.fullName,
      statusFrom: existing.status,
      statusTo: status,
      version: existing.version,
      comment
    });

    console.log(`Документ ПТО #${req.params.id}: ${existing.status} → ${status}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/pto/:id', requireRole(PTO_MANAGERS), (req, res) => {
  try {
    const existing = db
      .prepare('SELECT "Файл" as file FROM "Документ_ПТО" WHERE "ID_документа" = ?')
      .get(req.params.id);

    if (!existing) {
      return res.status(404).json({ success: false, error: 'Документ не найден' });
    }

    db.prepare('DELETE FROM "Документ_ПТО" WHERE "ID_документа" = ?').run(req.params.id);

    if (existing.file) {
      removeFileQuietly(path.join(__dirname, existing.file));
    }

    console.log(`Удалён документ ПТО #${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'Файл слишком большой (макс. 10 МБ для инструкций, 20 МБ для документов ПТО)' });
    }
    return res.status(400).json({ success: false, error: error.message });
  }
  if (error.message === 'Разрешены только PDF-файлы' || error.message === 'Разрешены файлы PDF, DOC, DOCX, XLS, XLSX') {
    return res.status(400).json({ success: false, error: error.message });
  }
  next(error);
});

app.delete('/api/articles/:id', requireRole(CONTENT_MANAGERS), (req, res) => {
  try {
    const getStmt = db.prepare('SELECT "Файл" as file FROM "Статья" WHERE "ID_статьи" = ?');
    const article = getStmt.get(req.params.id);
    
    if (!article) {
      return res.status(404).json({ success: false, error: 'Статья не найдена' });
    }
    
    const stmt = db.prepare('DELETE FROM "Статья" WHERE "ID_статьи" = ?');
    stmt.run(req.params.id);
    
    if (article.file) {
      removeFileQuietly(path.join(__dirname, article.file));
      console.log(`Удалён файл статьи: ${article.file}`);
    }
    console.log(`Удалена статья #${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend-html', 'index.html'));
});


app.listen(PORT, () => {
  console.log('Сервер ООО «ИНФОТЕХ БАЛАКОВО» запущен');
});

process.on('SIGINT', () => {
  console.log('\nЗакрытие соединения с БД');
  db.close();
  process.exit(0);
});
