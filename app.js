import { recoverFiles } from './lib/file-transaction.js';
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { ensureUploadsDir, openDatabase } from './lib/db.js';
import { SqliteSessionStore } from './lib/session-store.js';
import { corsMiddleware, createRateLimiter, csrfProtection, securityHeaders, verifySameOrigin } from './lib/security.js';
import { apiNotFound, attachRequestId, errorHandler, requireAuth } from './lib/middleware.js';
import { auditMiddleware } from './lib/audit.js';
import { createAuthRouter } from './routes/auth.js';
import { createStaffRouter } from './routes/staff.js';
import { createCatalogRouter } from './routes/catalog.js';
import { createPtoRouter } from './routes/pto.js';
import { createFilesRouter } from './routes/files.js';
import { createPreviewRouter } from './routes/preview.js';
import { createCompletenessRouter } from './routes/completeness.js';
import { createRemarksRouter } from './routes/remarks.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createReportsRouter } from './routes/reports.js';
import { createTasksRouter } from './routes/tasks.js';
import { createCompanyPhotosRouter } from './routes/company-photos.js';
import { createSearchRouter } from './routes/search.js';
import { createImportRouter } from './routes/import.js';
import { createAiRouter } from './routes/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db = openDatabase(), cfg = config } = {}) {
  ensureUploadsDir();
  recoverFiles(db);

  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');

  app.use(attachRequestId);
  app.use(securityHeaders);
  app.use(corsMiddleware);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  app.use(session({
    name: cfg.sessionCookieName,
    secret: cfg.sessionSecret,
    store: new SqliteSessionStore(db, { ttlMs: cfg.sessionTimeoutMinutes * 60 * 1000 }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: cfg.sessionTimeoutMinutes * 60 * 1000
    }
  }));

  // Ограничение частоты запросов к входу — отдельно и жёстче.
  app.use('/api/auth/login', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, name: 'login' }));

  app.use('/api', verifySameOrigin);

  // Вход публичный; изменяющие операции действующей сессии проверяет authRouter.
  app.use('/api/auth', createAuthRouter({ db }));

  // Все остальные /api требуют сессии.
  app.use('/api', createRateLimiter({ windowMs: 60 * 1000, max: 600, name: 'api' }));
  app.use('/api', requireAuth(db), csrfProtection);
  app.use('/api', auditMiddleware(db));

  app.use('/api', createStaffRouter({ db }));
  app.use('/api', createCatalogRouter({ db }));
  app.use('/api', createPtoRouter({ db }));
  app.use('/api', createFilesRouter({ db }));
  app.use('/api', createPreviewRouter({ db }));
  app.use('/api', createCompletenessRouter({ db }));
  app.use('/api', createRemarksRouter({ db }));
  app.use('/api', createNotificationsRouter({ db }));
  app.use('/api', createReportsRouter({ db }));
  app.use('/api/tasks', createTasksRouter({ db }));
  app.use('/api/company/photos', createCompanyPhotosRouter(cfg));
  app.use('/api', createSearchRouter({ db }));
  app.use('/api', createImportRouter({ db }));
  app.use('/api', createAiRouter({ db }));
  app.use('/api', apiNotFound);

  // Статика интерфейса. Папка uploads больше не раздаётся напрямую:
  // файлы доступны только через /api/files/* после проверки прав.
  app.use(express.static(path.join(__dirname, 'frontend-html'), { index: false, maxAge: 0, etag: true }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend-html', 'index.html'));
  });

  app.use(errorHandler());

  return { app, db };
}

export default createApp;
