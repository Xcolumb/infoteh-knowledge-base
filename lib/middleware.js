import { AppError, requestId, unauthorized } from './errors.js';
import { logger } from './logger.js';

export function attachRequestId(req, res, next) {
  req.id = requestId();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// Единственная точка проверки сессии: роль и статус читаются из БД,
// поэтому удалённый или заблокированный сотрудник теряет доступ сразу.
export function requireAuth(db) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return next(unauthorized());
    }

    const employee = db.prepare(`
      SELECT "ID_сотрудника" as id, "Табельный_номер" as tabNumber, "ФИО" as fullName,
             "Должность" as role, "Демо" as demo, "Заблокирован" as blocked
      FROM "Сотрудник" WHERE "ID_сотрудника" = ?
    `).get(req.session.userId);

    if (!employee || employee.blocked) {
      return req.session.destroy(() => next(unauthorized('Сессия недействительна, войдите заново')));
    }

    req.user = {
      id: employee.id,
      tabNumber: employee.tabNumber,
      fullName: employee.fullName,
      role: employee.role,
      demo: Boolean(employee.demo)
    };

    // Держим значения в сессии для журнала и уведомлений.
    req.session.role = employee.role;
    req.session.fullName = employee.fullName;

    next();
  };
}

export function apiNotFound(req, res) {
  res.status(404).json({ success: false, error: 'Метод API не найден', code: 'NOT_FOUND' });
}

export function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, next) => {
    const id = req.id || requestId();
    const rawStatus = error instanceof AppError ? error.status : Number(error && error.status);
    const status = rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;

    if (status >= 500) {
      logger.error('Необработанная ошибка', {
        requestId: id,
        method: req.method,
        path: req.originalUrl,
        message: error.message,
        stack: error.stack ? String(error.stack).split('\n').slice(0, 6).join(' | ') : undefined,
        userId: req.session ? req.session.userId : undefined
      });
    }

    if (res.headersSent) return;

    if (error && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'Файл слишком большой',
        code: 'FILE_TOO_LARGE',
        requestId: id
      });
    }

    if (error && (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE')) {
      return res.status(400).json({
        success: false,
        error: 'Можно приложить только один файл',
        code: 'FILE_LIMIT',
        requestId: id
      });
    }

    if (error instanceof AppError && error.details) {
      return res.status(status).json({
        success: false,
        error: error.message,
        code: error.code,
        details: error.details,
        requestId: id
      });
    }

    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Внутренняя ошибка сервера. Обратитесь к администратору.' : error.message,
      code: error.code || 'ERROR',
      requestId: id
    });
  };
}

export function ok(res, data = {}) {
  return res.json({ success: true, ...data });
}
