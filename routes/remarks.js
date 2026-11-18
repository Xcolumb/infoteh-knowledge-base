import express from 'express';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';
import { assertManagePto, assertObjectAccess, canAccessObject, isAdmin, objectScopeClause } from '../lib/permissions.js';
import { id as parseId, isoDate, oneOf, text } from '../lib/validate.js';
import { NOTIFICATION_TYPES, REMARK_CLOSED_STATUSES } from '../lib/constants.js';
import { upload, fileMeta, removeStoredQuietly } from '../lib/files.js';
import { writeAudit } from '../lib/audit.js';
import { notifyRecipients, recipientsFor } from '../lib/notifications.js';

const REMARK_SELECT = `
  SELECT z."ID_замечания" as id, z."Номер" as number, z."Дата" as date, z."ID_объекта" as objectId,
         o."Название" as objectName, z."ID_документа" as documentId, d."Название" as documentTitle,
         z."Описание" as description, z."Ответственный" as responsible, z."ID_ответственного" as responsibleId,
         z."Срок" as dueDate, z."Статус" as status, z."Дата_закрытия" as closedAt, z."ID_автора" as authorId,
         a."ФИО" as authorName, z."Создано" as createdAt, z."updated_at" as updatedAt
  FROM "Замечание" z
  LEFT JOIN "Объект" o ON z."ID_объекта" = o."ID_объекта"
  LEFT JOIN "Документ_ПТО" d ON z."ID_документа" = d."ID_документа"
  LEFT JOIN "Сотрудник" a ON z."ID_автора" = a."ID_сотрудника"
`;

function statuses(db) {
  return db.prepare('SELECT "Название" as name, "Порядок" as sortOrder, "Закрывающий" as closing FROM "Статус_замечания" ORDER BY "Порядок", "Название"').all();
}

function nextNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `ЗМ-${year}-`;
  const last = db.prepare(`SELECT "Номер" as number FROM "Замечание" WHERE "Номер" LIKE ? ORDER BY "ID_замечания" DESC LIMIT 1`).get(`${prefix}%`);
  const lastNumber = last ? Number(String(last.number).split('-').pop()) : 0;
  return `${prefix}${String(lastNumber + 1).padStart(3, '0')}`;
}

function getRemark(db, id) {
  return db.prepare(`${REMARK_SELECT} WHERE z."ID_замечания" = ?`).get(id);
}

function assertRemarkAccess(db, user, remark) {
  if (!remark) throw notFound('Замечание не найдено');
  assertObjectAccess(db, user, remark.objectId);
}

function addHistory(db, remarkId, action, { author, statusFrom = null, statusTo = null, comment = null }) {
  db.prepare(`
    INSERT INTO "История_замечания" ("ID_замечания", "Дата", "Автор", "Действие", "Статус_был", "Статус_стал", "Комментарий")
    VALUES (?, datetime('now', 'localtime'), ?, ?, ?, ?, ?)
  `).run(remarkId, author, action, statusFrom, statusTo, comment);
}

export function createRemarksRouter({ db }) {
  const router = express.Router();

  router.get('/remark-statuses', (req, res) => {
    ok(res, { data: statuses(db) });
  });

  router.post('/remark-statuses', (req, res, next) => {
    try {
      if (!isAdmin(req.user)) {
        return next(conflict('Изменять справочник статусов может только администратор'));
      }

      const name = text(req.body.name, { field: 'Статус', required: true, max: 100 });
      const closing = req.body.closing === true || req.body.closing === 'true' ? 1 : 0;
      const order = Number(req.body.order) || 0;

      db.prepare('INSERT OR IGNORE INTO "Статус_замечания" ("Название", "Порядок", "Закрывающий") VALUES (?, ?, ?)')
        .run(name, order, closing);

      writeAudit(db, { user: req.user, action: 'Добавление статуса замечания', entity: 'remark-status', result: 'success', ip: req.ip, details: { name } });
      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.get('/remarks', (req, res) => {
    const conditions = [];
    const params = [];

    const status = String(req.query.status || '').trim();
    if (status && status !== 'all') {
      conditions.push('z."Статус" = ?');
      params.push(status);
    }

    const objectId = String(req.query.objectId || '').trim();
    if (objectId && objectId !== 'all') {
      conditions.push('z."ID_объекта" = ?');
      params.push(Number(objectId));
    }

    const query = String(req.query.q || '').trim();
    if (query) {
      const like = `%${query}%`;
      conditions.push(`(z."Описание" LIKE ? OR COALESCE(z."Номер", '') LIKE ? OR COALESCE(z."Ответственный", '') LIKE ?)`);
      params.push(like, like, like);
    }

    if (String(req.query.overdue || '') === '1') {
      conditions.push(`z."Срок" IS NOT NULL AND z."Срок" <> '' AND z."Срок" < date('now', 'localtime')
        AND z."Статус" NOT IN (${REMARK_CLOSED_STATUSES.map(() => '?').join(', ')})`);
      params.push(...REMARK_CLOSED_STATUSES);
    }

    const scope = objectScopeClause(db, req.user, 'z."ID_объекта"');
    if (scope.clause) {
      conditions.push(scope.clause.replace(/^\s*AND\s*/, ''));
      params.push(...scope.params);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 200, 500);

    const rows = db.prepare(`${REMARK_SELECT} ${where} ORDER BY z."ID_замечания" DESC LIMIT ?`).all(...params, limit);

    ok(res, { data: rows, statuses: statuses(db) });
  });

  router.post('/remarks', (req, res, next) => {
    try {
      assertManagePto(req.user);

      const objectId = req.body.objectId ? parseId(req.body.objectId, { field: 'Объект' }) : null;
      const documentId = req.body.documentId ? parseId(req.body.documentId, { field: 'Документ' }) : null;
      const description = text(req.body.description, { field: 'Описание замечания', required: true, max: 5000 });
      const responsible = text(req.body.responsible, { field: 'Ответственный', max: 150 });
      const responsibleId = req.body.responsibleId ? parseId(req.body.responsibleId, { field: 'Ответственный' }) : null;
      const dueDate = isoDate(req.body.dueDate, { field: 'Срок' });
      const statusList = statuses(db).map((row) => row.name);
      const status = req.body.status ? oneOf(req.body.status, statusList, { field: 'Статус' }) : statusList[0];

      if (objectId) assertObjectAccess(db, req.user, objectId);

      const number = nextNumber(db);

      const result = db.prepare(`
        INSERT INTO "Замечание" ("Номер", "Дата", "ID_объекта", "ID_документа", "Описание", "Ответственный",
          "ID_ответственного", "Срок", "Статус", "ID_автора", "Создано", "updated_at")
        VALUES (?, date('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
      `).run(number, objectId, documentId, description, responsible, responsibleId, dueDate, status, req.user.id);

      addHistory(db, result.lastInsertRowid, 'Создано', { author: req.user.fullName, statusTo: status });

      const recipients = responsibleId ? [responsibleId] : recipientsFor(db, responsible);
      notifyRecipients(db, recipients, {
        type: NOTIFICATION_TYPES.REMARK_NEW,
        text: `Новое замечание ${number}: назначен срок ${dueDate || 'не указан'}`,
        link: `remark:${result.lastInsertRowid}`,
        key: `remark-new:${result.lastInsertRowid}:${Date.now()}`
      });

      writeAudit(db, {
        user: req.user, action: 'Создание замечания', entity: 'remark', entityId: result.lastInsertRowid,
        objectId, result: 'success', ip: req.ip, details: { number }
      });

      ok(res, { data: { id: result.lastInsertRowid, number } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/remarks/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Замечание' });
      const remark = getRemark(db, id);
      assertRemarkAccess(db, req.user, remark);

      remark.comments = db.prepare(`
        SELECT "ID_комментария" as id, "Текст" as text, "Автор" as author, "Создано" as createdAt
        FROM "Комментарий_замечания" WHERE "ID_замечания" = ? ORDER BY "ID_комментария"
      `).all(id);

      remark.attachments = db.prepare(`
        SELECT "ID_вложения" as id, "Файл" as filePath, "Оригинальное_имя" as originalName,
               "Размер" as size, "MIME" as mime, "Автор" as author, "Создано" as createdAt
        FROM "Вложение_замечания" WHERE "ID_замечания" = ? ORDER BY "ID_вложения"
      `).all(id).map((row) => ({ ...row, file: `/api/files/remark/${row.id}` }));

      remark.history = db.prepare(`
        SELECT "ID_записи" as id, "Дата" as date, "Автор" as author, "Действие" as action,
               "Статус_был" as statusFrom, "Статус_стал" as statusTo, "Комментарий" as comment
        FROM "История_замечания" WHERE "ID_замечания" = ? ORDER BY "ID_записи" DESC
      `).all(id);

      ok(res, { data: remark });
    } catch (error) {
      next(error);
    }
  });

  router.put('/remarks/:id', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Замечание' });
      const remark = getRemark(db, id);
      assertRemarkAccess(db, req.user, remark);

      const objectId = req.body.objectId ? parseId(req.body.objectId, { field: 'Объект' }) : remark.objectId;
      if (objectId) assertObjectAccess(db, req.user, objectId);

      const description = text(req.body.description, { field: 'Описание замечания', required: true, max: 5000 });
      const responsible = text(req.body.responsible, { field: 'Ответственный', max: 150 });
      const responsibleId = req.body.responsibleId ? parseId(req.body.responsibleId, { field: 'Ответственный' }) : null;
      const dueDate = isoDate(req.body.dueDate, { field: 'Срок' });
      const statusList = statuses(db);
      const status = oneOf(req.body.status || remark.status, statusList.map((row) => row.name), { field: 'Статус' });
      const closing = statusList.find((row) => row.name === status);

      db.prepare(`
        UPDATE "Замечание"
        SET "ID_объекта" = ?, "Описание" = ?, "Ответственный" = ?, "ID_ответственного" = ?, "Срок" = ?,
            "Статус" = ?, "Дата_закрытия" = ?, "updated_at" = datetime('now', 'localtime')
        WHERE "ID_замечания" = ?
      `).run(
        objectId, description, responsible, responsibleId, dueDate, status,
        closing && closing.closing ? (remark.closedAt || new Date().toISOString().slice(0, 10)) : null,
        id
      );

      if (remark.status !== status) {
        addHistory(db, id, 'Смена статуса', {
          author: req.user.fullName,
          statusFrom: remark.status,
          statusTo: status,
          comment: text(req.body.comment, { field: 'Комментарий', max: 1000 })
        });
      }

      writeAudit(db, {
        user: req.user, action: 'Изменение замечания', entity: 'remark', entityId: id,
        objectId, result: 'success', ip: req.ip
      });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.patch('/remarks/:id/status', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Замечание' });
      const remark = getRemark(db, id);
      assertRemarkAccess(db, req.user, remark);

      const statusList = statuses(db);
      const status = oneOf(req.body.status, statusList.map((row) => row.name), { field: 'Статус' });
      if (status === remark.status) throw badRequest('Замечание уже в этом статусе');

      const closing = statusList.find((row) => row.name === status);

      db.prepare(`
        UPDATE "Замечание" SET "Статус" = ?, "Дата_закрытия" = ?, "updated_at" = datetime('now', 'localtime')
        WHERE "ID_замечания" = ?
      `).run(status, closing && closing.closing ? new Date().toISOString().slice(0, 10) : null, id);

      addHistory(db, id, 'Смена статуса', {
        author: req.user.fullName,
        statusFrom: remark.status,
        statusTo: status,
        comment: text(req.body.comment, { field: 'Комментарий', max: 1000 })
      });

      writeAudit(db, { user: req.user, action: 'Смена статуса замечания', entity: 'remark', entityId: id, objectId: remark.objectId, result: 'success', ip: req.ip, details: { from: remark.status, to: status } });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.post('/remarks/:id/comments', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Замечание' });
      const remark = getRemark(db, id);
      assertRemarkAccess(db, req.user, remark);

      const comment = text(req.body.text, { field: 'Комментарий', required: true, max: 2000 });

      db.prepare('INSERT INTO "Комментарий_замечания" ("ID_замечания", "Текст", "Автор", "Создано") VALUES (?, ?, ?, datetime(\'now\', \'localtime\'))')
        .run(id, comment, req.user.fullName);

      addHistory(db, id, 'Комментарий', { author: req.user.fullName, comment });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.post('/remarks/:id/attachments', upload.single('file'), asyncHandler(async (req, res) => {
    assertManagePto(req.user);
    const id = parseId(req.params.id, { field: 'Замечание' });
    const remark = getRemark(db, id);
    assertRemarkAccess(db, req.user, remark);

    const meta = fileMeta(req.file);
    if (!meta) throw badRequest('Файл не приложен');

    try {
      db.prepare(`
        INSERT INTO "Вложение_замечания" ("ID_замечания", "Файл", "Оригинальное_имя", "Размер", "MIME", "Автор", "Создано")
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `).run(id, meta.storedPath, meta.originalName, meta.size, meta.mime, req.user.fullName);

      addHistory(db, id, 'Добавлено вложение', { author: req.user.fullName, comment: meta.originalName });

      writeAudit(db, { user: req.user, action: 'Вложение к замечанию', entity: 'remark', entityId: id, objectId: remark.objectId, result: 'success', ip: req.ip });

      ok(res, {});
    } catch (error) {
      removeStoredQuietly(meta.storedPath);
      throw error;
    }
  }));

  router.delete('/remarks/:id', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Замечание' });
      const remark = getRemark(db, id);
      assertRemarkAccess(db, req.user, remark);

      if (!isAdmin(req.user) && remark.authorId && remark.authorId !== req.user.id) {
        throw conflict('Удалить замечание другого автора может только администратор');
      }

      const attachments = db.prepare('SELECT "Файл" as file FROM "Вложение_замечания" WHERE "ID_замечания" = ?').all(id);

      db.prepare('DELETE FROM "Замечание" WHERE "ID_замечания" = ?').run(id);
      for (const attachment of attachments) removeStoredQuietly(attachment.file);

      writeAudit(db, { user: req.user, action: 'Удаление замечания', entity: 'remark', entityId: id, objectId: remark.objectId, result: 'success', ip: req.ip });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createRemarksRouter;
