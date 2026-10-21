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

  const validRoles = ['Монтажник', 'Старший монтажник', 'Администратор'];
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
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'Файл слишком большой (макс. 10MB)' });
    }
    return res.status(400).json({ success: false, error: error.message });
  }
  if (error.message === 'Разрешены только PDF-файлы') {
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
  console.log('Сервер ИнфоТех запущен');
});

process.on('SIGINT', () => {
  console.log('\nЗакрытие соединения с БД');
  db.close();
  process.exit(0);
});
