import { NOTIFICATION_TYPES, PTO_CLOSED_STATUSES, REMARK_CLOSED_STATUSES } from './constants.js';
import { logger } from './logger.js';

function todayIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function createNotification(db, { userId, type, text, link = null, key = null }) {
  if (!userId) return null;

  try {
    const result = db.prepare(`
      INSERT INTO "Уведомление" ("ID_сотрудника", "Тип", "Текст", "Ссылка", "Ключ", "Прочитано", "Создано")
      VALUES (?, ?, ?, ?, ?, 0, datetime('now', 'localtime'))
      ON CONFLICT ("ID_сотрудника", "Ключ") DO NOTHING
    `).run(userId, type, text, link, key);

    return result.changes ? result.lastInsertRowid : null;
  } catch (error) {
    logger.warn('Не удалось создать уведомление', { error: error.message });
    return null;
  }
}

// Кому отправлять: ответственный по ФИО, если найден, иначе все администраторы
// и инженеры ПТО (без дублей).
export function recipientsFor(db, responsibleName) {
  const ids = new Set();

  if (responsibleName) {
    const employee = db
      .prepare('SELECT "ID_сотрудника" as id FROM "Сотрудник" WHERE "ФИО" = ? AND "Заблокирован" = 0')
      .get(String(responsibleName).trim());

    if (employee) ids.add(employee.id);
  }

  const fallback = db
    .prepare(`SELECT "ID_сотрудника" as id FROM "Сотрудник" WHERE "Должность" IN ('Администратор', 'Инженер ПТО') AND "Заблокирован" = 0`)
    .all();

  for (const row of fallback) ids.add(row.id);

  return Array.from(ids);
}

export function notifyRecipients(db, recipients, { type, text, link, key }) {
  for (const id of recipients) {
    createNotification(db, { userId: id, type, text, link, key: `${key}:${id}` });
  }
}

export function notifyStatusChange(db, document, { statusFrom, statusTo, comment, actor }) {
  const recipients = recipientsFor(db, document.Ответственный || document.responsible);
  const title = document.Название || document.title || 'Документ';

  notifyRecipients(db, recipients, {
    type: NOTIFICATION_TYPES.DOC_STATUS_CHANGED,
    text: `«${title}»: статус изменён с «${statusFrom}» на «${statusTo}»${comment ? ` (${comment})` : ''}`,
    link: `pto:${document.ID_документа || document.id}`,
    key: `status:${document.ID_документа || document.id}:${statusTo}:${Date.now()}`
  });
}

export function generateScheduledNotifications(db) {
  const today = todayIso(0);
  const soon = todayIso(3);
  const created = { docs: 0, remarks: 0 };

  const documents = db.prepare(`
    SELECT "ID_документа" as id, "Название" as title, "Срок" as due, "Статус" as status,
           "Ответственный" as responsible, "ID_объекта" as objectId
    FROM "Документ_ПТО"
    WHERE "Срок" IS NOT NULL AND "Срок" <> ''
  `).all();

  for (const doc of documents) {
    if (PTO_CLOSED_STATUSES.includes(doc.status)) continue;

    const isOverdue = doc.due < today;
    const isSoon = !isOverdue && doc.due <= soon;

    if (!isOverdue && !isSoon) continue;

    const recipients = recipientsFor(db, doc.responsible);
    const type = isOverdue ? NOTIFICATION_TYPES.DOC_OVERDUE : NOTIFICATION_TYPES.DOC_DUE_SOON;
    const text = isOverdue
      ? `Документ «${doc.title}» просрочен (срок ${doc.due})`
      : `Документ «${doc.title}»: срок ${doc.due} приближается`;

    for (const userId of recipients) {
      const key = `${type}:${doc.id}:${doc.due}:${userId}`;
      const result = createNotification(db, { userId, type, text, link: `pto:${doc.id}`, key });
      if (result) created.docs += 1;
    }
  }

  const remarks = db.prepare(`
    SELECT "ID_замечания" as id, "Номер" as number, "Срок" as due, "Статус" as status,
           "Ответственный" as responsible, "ID_ответственного" as responsibleId, "Описание" as description
    FROM "Замечание"
    WHERE "Срок" IS NOT NULL AND "Срок" <> ''
  `).all();

  for (const remark of remarks) {
    if (REMARK_CLOSED_STATUSES.includes(remark.status)) continue;

    const isOverdue = remark.due < today;
    const isSoon = !isOverdue && remark.due <= soon;
    if (!isOverdue && !isSoon) continue;

    const recipients = remark.responsibleId ? [remark.responsibleId] : recipientsFor(db, remark.responsible);
    const type = isOverdue ? NOTIFICATION_TYPES.REMARK_OVERDUE : NOTIFICATION_TYPES.REMARK_DUE_SOON;
    const text = isOverdue
      ? `Замечание №${remark.number || remark.id} просрочено (срок ${remark.due})`
      : `Замечание №${remark.number || remark.id}: срок ${remark.due} приближается`;

    for (const userId of recipients) {
      const key = `${type}:${remark.id}:${remark.due}:${userId}`;
      const result = createNotification(db, { userId, type, text, link: `remark:${remark.id}`, key });
      if (result) created.remarks += 1;
    }
  }

  return created;
}

export function unreadCount(db, userId) {
  const row = db.prepare('SELECT COUNT(*) as count FROM "Уведомление" WHERE "ID_сотрудника" = ? AND "Прочитано" = 0').get(userId);
  return row ? row.count : 0;
}

export function markRead(db, userId, notificationId) {
  db.prepare('UPDATE "Уведомление" SET "Прочитано" = 1 WHERE "ID_уведомления" = ? AND "ID_сотрудника" = ?')
    .run(notificationId, userId);
}

export function markAllRead(db, userId) {
  db.prepare('UPDATE "Уведомление" SET "Прочитано" = 1 WHERE "ID_сотрудника" = ?').run(userId);
}

export function runNotificationScheduler(db, intervalMinutes = 60) {
  const tick = () => {
    try {
      generateScheduledNotifications(db);
    } catch (error) {
      logger.warn('Ошибка генерации уведомлений', { error: error.message });
    }
  };

  tick();
  const timer = setInterval(tick, Math.max(5, intervalMinutes) * 60 * 1000);
  timer.unref?.();
  return timer;
}

export default {
  createNotification,
  generateScheduledNotifications,
  unreadCount,
  markRead,
  markAllRead,
  runNotificationScheduler
};
