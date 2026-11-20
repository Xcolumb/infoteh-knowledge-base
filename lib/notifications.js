import { NOTIFICATION_TYPES, PTO_CLOSED_STATUSES, REMARK_CLOSED_STATUSES } from './constants.js';
import { canUseTasks, canAccessObject, objectScopeClause } from './permissions.js';
import { notFound } from './errors.js';
import { logger } from './logger.js';

function todayIso(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function createNotification(db, { userId, objectId, type, text, link = null, key = null, strict = false }) {
  if (!userId) return null;

  try {
    const employee = db.prepare('SELECT "ID_сотрудника" AS id, "Должность" AS role FROM "Сотрудник" WHERE "ID_сотрудника" = ? AND "Заблокирован" = 0').get(userId);
    if (!employee || !canAccessObject(db, employee, objectId)) return null;
    if (link?.startsWith('task:') && !canUseTasks(employee)) return null;
    const result = db.prepare(`
      INSERT INTO "Уведомление" ("ID_сотрудника", "Тип", "Текст", "Ссылка", "Ключ", "Прочитано", "Создано")
      VALUES (?, ?, ?, ?, ?, 0, datetime('now', 'localtime'))
      ON CONFLICT ("ID_сотрудника", "Ключ") DO NOTHING
    `).run(userId, type, text, link, `scope:${objectId ?? 0}:${key}`);

    return result.changes ? result.lastInsertRowid : null;
  } catch (error) {
    if (strict) throw error;
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

export function notifyRecipients(db, recipients, { objectId, type, text, link, key }) {
  for (const id of recipients) {
    createNotification(db, { userId: id, objectId, type, text, link, key: `${key}:${id}` });
  }
}

export function notifyStatusChange(db, document, { statusFrom, statusTo, comment, actor }) {
  const recipients = recipientsFor(db, document.Ответственный || document.responsible);
  const title = document.Название || document.title || 'Документ';

  const change = statusFrom ? `статус изменён с «${statusFrom}» на «${statusTo}»` : `текущий статус «${statusTo}»`;
  notifyRecipients(db, recipients, {
    objectId: document.objectId,
    type: NOTIFICATION_TYPES.DOC_STATUS_CHANGED,
    text: `«${title}»: ${change}${comment ? ` (${comment})` : ''}`,
    link: `pto:${document.ID_документа || document.id}`,
    key: `status:${document.ID_документа || document.id}:${statusTo}:${Date.now()}`
  });
}

export function generateScheduledNotifications(db, user = null) {
  const today = todayIso(0);
  const soon = todayIso(3);
  const created = { docs: 0, remarks: 0 };

  // Без пользователя вызывается только внутренний планировщик.
  const scope = user ? objectScopeClause(db, user, '"ID_объекта"') : { clause: '', params: [] };
  const documents = db.prepare(`
    SELECT "ID_документа" as id, "Название" as title, "Срок" as due, "Статус" as status,
           "Ответственный" as responsible, "ID_объекта" as objectId
    FROM "Документ_ПТО"
    WHERE "Срок" IS NOT NULL AND "Срок" <> '' ${scope.clause}
  `).all(...scope.params);

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
      const result = createNotification(db, { userId, objectId: doc.objectId, type, text, link: `pto:${doc.id}`, key });
      if (result) created.docs += 1;
    }
  }

  const remarks = db.prepare(`
    SELECT "ID_замечания" as id, "Номер" as number, "Срок" as due, "Статус" as status,
           "Ответственный" as responsible, "ID_ответственного" as responsibleId, "ID_объекта" as objectId
    FROM "Замечание"
    WHERE "Срок" IS NOT NULL AND "Срок" <> '' ${scope.clause}
  `).all(...scope.params);

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
      const result = createNotification(db, { userId, objectId: remark.objectId, type, text, link: `remark:${remark.id}`, key });
      if (result) created.remarks += 1;
    }
  }

  return created;
}

// Архивируем прежнюю привязку в транзакции переноса. Само сообщение сохраняется.
export function archiveSourceNotifications(db, link) {
  db.prepare(`UPDATE "Уведомление" SET "Ссылка" = 'archived:' || "Ссылка",
    "Ключ" = 'archived:' || "ID_уведомления" WHERE "Ссылка" = ?`).run(link);
}

function visibleNotifications(db, user) {
  const object = 'COALESCE(d."ID_объекта", z."ID_объекта", t.objectId)';
  const scope = objectScopeClause(db, user, object);
  // Соединение по числовому PK; полное совпадение ссылки исключает повреждённые и архивные ссылки.
  const sql = `
    FROM "Уведомление" n
    LEFT JOIN "Документ_ПТО" d ON d."ID_документа" = CAST(substr(n."Ссылка", 5) AS INTEGER)
      AND n."Ссылка" = 'pto:' || d."ID_документа"
    LEFT JOIN "Замечание" z ON z."ID_замечания" = CAST(substr(n."Ссылка", 8) AS INTEGER)
      AND n."Ссылка" = 'remark:' || z."ID_замечания"
    LEFT JOIN Задача t ON t.id = CAST(substr(n."Ссылка", 6) AS INTEGER) AND n."Ссылка" = 'task:' || t.id AND ? = 1
    WHERE n."ID_сотрудника" = ? AND (d."ID_документа" IS NOT NULL OR z."ID_замечания" IS NOT NULL OR t.id IS NOT NULL)
      AND (COALESCE(n."Ключ", '') NOT LIKE 'scope:%' OR n."Ключ" LIKE 'scope:' || COALESCE(${object}, 0) || ':%')
      ${scope.clause}`;
  return { sql, params: [Number(canUseTasks(user)), user.id, ...scope.params] };
}

export function listNotifications(db, user, onlyUnread, limit) {
  const { sql, params } = visibleNotifications(db, user);
  // У старых сообщений объект на момент отправки неизвестен. Не показываем сохранённый текст.
  return db.prepare(`SELECT n."ID_уведомления" as id, n."Тип" as type,
    CASE WHEN n."Ключ" LIKE 'scope:%' THEN n."Текст" ELSE n."Тип" END as text,
    n."Ссылка" as link, n."Прочитано" as read, n."Создано" as createdAt
    ${sql} ${onlyUnread ? 'AND n."Прочитано" = 0' : ''}
    ORDER BY n."ID_уведомления" DESC LIMIT ?`).all(...params, limit);
}

export function unreadCount(db, user) {
  const { sql, params } = visibleNotifications(db, user);
  return db.prepare(`SELECT COUNT(*) as count ${sql} AND n."Прочитано" = 0`).get(...params).count;
}

export function markRead(db, user, notificationId) {
  const { sql, params } = visibleNotifications(db, user);
  const result = db.prepare(`UPDATE "Уведомление" SET "Прочитано" = 1 WHERE "ID_уведомления" IN
    (SELECT n."ID_уведомления" ${sql} AND n."ID_уведомления" = ?)`).run(...params, notificationId);
  if (!result.changes) throw notFound();
}

export function markAllRead(db, user) {
  const { sql, params } = visibleNotifications(db, user);
  db.prepare(`UPDATE "Уведомление" SET "Прочитано" = 1 WHERE "ID_уведомления" IN
    (SELECT n."ID_уведомления" ${sql} AND n."Прочитано" = 0)`).run(...params);
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
