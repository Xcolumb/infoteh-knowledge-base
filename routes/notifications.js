import express from 'express';
import { ok } from '../lib/middleware.js';
import { unreadCount, markRead, markAllRead, generateScheduledNotifications } from '../lib/notifications.js';
import { id as parseId } from '../lib/validate.js';
import { canManagePto } from '../lib/permissions.js';

export function createNotificationsRouter({ db }) {
  const router = express.Router();

  router.get('/notifications', (req, res) => {
    const onlyUnread = String(req.query.onlyUnread || '') === '1';
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const rows = db.prepare(`
      SELECT "ID_уведомления" as id, "Тип" as type, "Текст" as text, "Ссылка" as link,
             "Прочитано" as read, "Создано" as createdAt
      FROM "Уведомление"
      WHERE "ID_сотрудника" = ? ${onlyUnread ? 'AND "Прочитано" = 0' : ''}
      ORDER BY "ID_уведомления" DESC
      LIMIT ?
    `).all(req.user.id, limit);

    ok(res, {
      data: rows.map((row) => ({ ...row, read: Boolean(row.read) })),
      unread: unreadCount(db, req.user.id)
    });
  });

  router.get('/notifications/unread-count', (req, res) => {
    ok(res, { unread: unreadCount(db, req.user.id) });
  });

  router.post('/notifications/:id/read', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Уведомление' });
      markRead(db, req.user.id, id);
      ok(res, { unread: unreadCount(db, req.user.id) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/notifications/read-all', (req, res) => {
    markAllRead(db, req.user.id);
    ok(res, { unread: 0 });
  });

  // Ручной запуск планировщика — для администратора и инженера ПТО (проверка работы).
  router.post('/notifications/scan', (req, res, next) => {
    try {
      if (!canManagePto(req.user)) {
        return next(Object.assign(new Error('Недостаточно прав'), { status: 403, code: 'FORBIDDEN' }));
      }

      const created = generateScheduledNotifications(db);
      ok(res, { created });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createNotificationsRouter;
