import { logger } from './logger.js';

// Журнал действий пользователей. Записи доступны только на чтение через API
// (раздел «Журнал» для администратора), изменить их через интерфейс нельзя.
export function writeAudit(db, {
  user = null,
  action,
  entity = null,
  entityId = null,
  objectId = null,
  result = 'success',
  ip = null,
  details = null
} = {}) {
  try {
    db.prepare(`
      INSERT INTO "Аудит"
        ("Дата", "ID_сотрудника", "ФИО", "Действие", "Сущность", "ID_сущности", "ID_объекта", "Результат", "IP", "Детали")
      VALUES (datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user ? Number(user.id) : null,
      user ? String(user.fullName || '') : null,
      String(action),
      entity,
      entityId === null || entityId === undefined ? null : Number(entityId),
      objectId === null || objectId === undefined ? null : Number(objectId),
      result,
      ip ? String(ip).slice(0, 64) : null,
      details ? JSON.stringify(details).slice(0, 4000) : null
    );
  } catch (error) {
    logger.error('Не удалось записать аудит', { error: error.message, action });
  }
}

// Готовый middleware: пишет факт изменяющего запроса после завершения ответа.
export function auditMiddleware(db) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) return next();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    const startedAt = Date.now();
    const user = { id: req.session.userId, fullName: req.session.fullName };

    res.on('finish', () => {
      writeAudit(db, {
        user,
        action: `${req.method} ${req.baseUrl || ''}${req.path === '/' ? '' : req.path}`.slice(0, 190),
        entity: 'api',
        result: res.statusCode < 400 ? 'success' : 'failed',
        ip: req.ip,
        details: {
          status: res.statusCode,
          ms: Date.now() - startedAt,
          // Содержимое запроса не пишем: там могут быть персональные данные и файлы.
          size: req.headers['content-length'] || 0
        }
      });
    });

    next();
  };
}

export default writeAudit;
