import express from 'express';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';
import { assertManagePto, assertObjectAccess, canAccessObject, isAdmin, objectScopeClause } from '../lib/permissions.js';
import { id as parseId, isoDate, oneOf, text } from '../lib/validate.js';
import { PTO_CLOSED_STATUSES, PTO_STATUSES, PTO_TYPES } from '../lib/constants.js';
import { upload, fileMeta, removeStoredQuietly } from '../lib/files.js';
import { ensureDocumentText, indexDocument, removeIndex } from '../lib/search.js';
import { writeAudit } from '../lib/audit.js';
import { notifyRecipients, notifyStatusChange, recipientsFor } from '../lib/notifications.js';
import { NOTIFICATION_TYPES } from '../lib/constants.js';

const DOC_SELECT = `
  SELECT d."ID_документа" as id, d."Тип" as type, d."Название" as title,
         d."ID_объекта" as objectId, o."Название" as objectName,
         d."Шифр" as cipher, d."Раздел_проекта" as projectSection, d."Статус" as status,
         d."Срок" as dueDate, d."Ответственный" as responsible, d."Текст" as content,
         d."Файл" as filePath, d."Оригинальное_имя" as originalName, d."Размер" as size, d."MIME" as mime,
         d."Версия" as version, d."Актуализирован" as actualizedAt, d."Требуется_OCR" as requiresOcr,
         d."ID_автора" as authorId, a."ФИО" as authorName, d."updated_at" as updatedAt
  FROM "Документ_ПТО" d
  LEFT JOIN "Объект" o ON d."ID_объекта" = o."ID_объекта"
  LEFT JOIN "Сотрудник" a ON d."ID_автора" = a."ID_сотрудника"
`;

function present(doc) {
  if (!doc) return doc;
  return { ...doc, file: doc.filePath ? `/api/files/document/${doc.id}` : null };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function getDoc(db, id) {
  return db.prepare(`${DOC_SELECT} WHERE d."ID_документа" = ?`).get(id);
}

function assertDocAccess(db, user, doc) {
  if (!doc) throw notFound('Документ не найден');
  assertObjectAccess(db, user, doc.objectId);
}

function addHistory(db, documentId, action, { author = null, statusFrom = null, statusTo = null, version = null, comment = null } = {}) {
  db.prepare(`
    INSERT INTO "История_ПТО" ("ID_документа", "Дата", "Автор", "Действие", "Статус_был", "Статус_стал", "Версия", "Комментарий")
    VALUES (?, datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?)
  `).run(documentId, author, action, statusFrom, statusTo, version, comment);
}

function addRevision(db, documentId, { version, file, originalName, size, mime, comment, author }) {
  db.prepare(`
    INSERT INTO "Редакция_ПТО" ("ID_документа", "Версия", "Файл", "Оригинальное_имя", "Размер", "MIME", "Комментарий", "Автор", "Создано")
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
  `).run(documentId, version, file, originalName, size, mime, comment, author);
}

function parseDocFields(body) {
  const type = oneOf(body.type, PTO_TYPES, { field: 'Тип документа' });
  const title = text(body.title, { field: 'Наименование', required: true, max: 300 });
  const status = oneOf(body.status || 'Черновик', PTO_STATUSES, { field: 'Статус' });
  const dueDate = isoDate(body.dueDate, { field: 'Срок' });
  const objectId = body.objectId ? parseId(body.objectId, { field: 'Объект' }) : null;
  const cipher = text(body.cipher, { field: 'Шифр', max: 100 });
  const projectSection = text(body.projectSection, { field: 'Раздел проекта', max: 100 });
  const responsible = text(body.responsible, { field: 'Ответственный', max: 150 });
  const content = text(body.content, { field: 'Описание', max: 20000 });

  return { type, title, status, dueDate, objectId, cipher, projectSection, responsible, content };
}

export function createPtoRouter({ db }) {
  const router = express.Router();

  // --- Справочники ---

  router.get('/pto/meta', (req, res) => {
    const objects = db.prepare('SELECT "ID_объекта" as id, "Название" as name FROM "Объект" ORDER BY "Название"').all()
      .filter((object) => canAccessObject(db, req.user, object.id));

    ok(res, {
      types: PTO_TYPES,
      statuses: PTO_STATUSES,
      closedStatuses: PTO_CLOSED_STATUSES,
      objects,
      canManage: ['Администратор', 'Инженер ПТО'].includes(req.user.role)
    });
  });

  // --- Объекты ---

  router.get('/objects', (req, res) => {
    const rows = db.prepare(`
      SELECT o."ID_объекта" as id, o."Название" as name, o."Адрес" as address, o."Заказчик" as customer,
             o."updated_at" as updatedAt,
             (SELECT COUNT(*) FROM "Документ_ПТО" d WHERE d."ID_объекта" = o."ID_объекта") as documentsCount
      FROM "Объект" o
      ORDER BY o."Название"
    `).all();

    ok(res, { data: rows.filter((row) => canAccessObject(db, req.user, row.id)) });
  });

  router.post('/objects', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });
      const address = text(req.body.address, { field: 'Адрес', max: 300 });
      const customer = text(req.body.customer, { field: 'Заказчик', max: 200 });

      const result = db.prepare(`
        INSERT INTO "Объект" ("Название", "Адрес", "Заказчик", "updated_at")
        VALUES (?, ?, ?, datetime('now', 'localtime'))
      `).run(name, address, customer);

      // Создатель объекта сразу получает к нему доступ (для роли «Инженер ПТО»).
      db.prepare('INSERT OR IGNORE INTO "Доступ_объект" ("ID_сотрудника", "ID_объекта") VALUES (?, ?)')
        .run(req.user.id, result.lastInsertRowid);

      writeAudit(db, { user: req.user, action: 'Создание объекта', entity: 'object', entityId: result.lastInsertRowid, result: 'success', ip: req.ip, details: { name } });

      ok(res, { data: { id: result.lastInsertRowid, name, address, customer } });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(conflict('Объект с таким названием уже существует'));
      next(error);
    }
  });

  router.put('/objects/:id', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Объект' });
      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });
      const address = text(req.body.address, { field: 'Адрес', max: 300 });
      const customer = text(req.body.customer, { field: 'Заказчик', max: 200 });

      const result = db.prepare(`
        UPDATE "Объект" SET "Название" = ?, "Адрес" = ?, "Заказчик" = ?, "updated_at" = datetime('now', 'localtime')
        WHERE "ID_объекта" = ?
      `).run(name, address, customer, id);

      if (!result.changes) throw notFound('Объект не найден');

      writeAudit(db, { user: req.user, action: 'Изменение объекта', entity: 'object', entityId: id, result: 'success', ip: req.ip });
      ok(res, {});
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(conflict('Объект с таким названием уже существует'));
      next(error);
    }
  });

  router.delete('/objects/:id', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Объект' });

      const count = db.prepare('SELECT COUNT(*) as count FROM "Документ_ПТО" WHERE "ID_объекта" = ?').get(id).count;
      if (count > 0) throw conflict(`Невозможно удалить: к объекту привязано ${count} документов`);

      const remarks = db.prepare('SELECT COUNT(*) as count FROM "Замечание" WHERE "ID_объекта" = ?').get(id).count;
      if (remarks > 0) throw conflict(`Невозможно удалить: к объекту привязано ${remarks} замечаний`);

      const result = db.prepare('DELETE FROM "Объект" WHERE "ID_объекта" = ?').run(id);
      if (!result.changes) throw notFound('Объект не найден');

      writeAudit(db, { user: req.user, action: 'Удаление объекта', entity: 'object', entityId: id, result: 'success', ip: req.ip });
      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  // --- Документы ПТО ---

  router.get('/pto', (req, res) => {
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

    const query = String(req.query.q || '').trim();
    if (query) {
      const like = `%${query}%`;
      conditions.push(`(d."Название" LIKE ? OR COALESCE(d."Шифр", '') LIKE ? OR COALESCE(d."Раздел_проекта", '') LIKE ?
        OR COALESCE(o."Название", '') LIKE ? OR COALESCE(d."Ответственный", '') LIKE ?)`);
      params.push(like, like, like, like, like);
    }

    if (String(req.query.overdue || '') === '1') {
      conditions.push(`d."Срок" IS NOT NULL AND d."Срок" <> '' AND d."Срок" < date('now', 'localtime')
        AND d."Статус" NOT IN ('Утверждён', 'В архиве')`);
    }

    const scope = objectScopeClause(db, req.user, 'd."ID_объекта"');
    if (scope.clause) {
      conditions.push(scope.clause.replace(/^\s*AND\s*/, ''));
      params.push(...scope.params);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const rows = db.prepare(`
      ${DOC_SELECT} ${where}
      ORDER BY CASE WHEN d."Срок" IS NULL OR d."Срок" = '' THEN 1 ELSE 0 END, d."Срок", d."ID_документа"
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    ok(res, { data: rows.map(present), limit, offset });
  });

  router.get('/pto/export.csv', (req, res) => {
    const conditions = [];
    const params = [];

    const type = String(req.query.type || '').trim();
    if (type && type !== 'all') { conditions.push('d."Тип" = ?'); params.push(type); }

    const status = String(req.query.status || '').trim();
    if (status && status !== 'all') { conditions.push('d."Статус" = ?'); params.push(status); }

    const objectId = String(req.query.objectId || '').trim();
    if (objectId && objectId !== 'all') { conditions.push('d."ID_объекта" = ?'); params.push(Number(objectId)); }

    const scope = objectScopeClause(db, req.user, 'd."ID_объекта"');
    if (scope.clause) {
      conditions.push(scope.clause.replace(/^\s*AND\s*/, ''));
      params.push(...scope.params);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db.prepare(`
      ${DOC_SELECT} ${where}
      ORDER BY CASE WHEN d."Срок" IS NULL OR d."Срок" = '' THEN 1 ELSE 0 END, d."Срок", d."ID_документа"
    `).all(...params);

    const cell = (value) => {
      const string = String(value ?? '');
      return /[";\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
    };

    const header = ['№', 'Тип', 'Наименование', 'Объект', 'Шифр', 'Раздел проекта', 'Статус', 'Срок',
      'Ответственный', 'Версия', 'Актуализирован', 'Обновлён', 'Файл'];

    const lines = [header.map(cell).join(';')];
    rows.forEach((row, index) => {
      lines.push([
        index + 1, row.type, row.title, row.objectName || '', row.cipher || '', row.projectSection || '',
        row.status, row.dueDate || '', row.responsible || '', row.version, row.actualizedAt || '',
        row.updatedAt || '', row.originalName || (row.filePath ? String(row.filePath).split('/').pop() : '')
      ].map(cell).join(';'));
    });

    writeAudit(db, { user: req.user, action: 'Экспорт реестра ПТО', entity: 'ptо', result: 'success', ip: req.ip, details: { rows: rows.length } });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reestr-pto-${todayIso()}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  });

  router.get('/pto/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Документ' });
      const doc = getDoc(db, id);
      assertDocAccess(db, req.user, doc);

      const history = db.prepare(`
        SELECT "ID_записи" as id, "Дата" as date, "Автор" as author, "Действие" as action,
               "Статус_был" as statusFrom, "Статус_стал" as statusTo, "Версия" as version, "Комментарий" as comment
        FROM "История_ПТО" WHERE "ID_документа" = ? ORDER BY "Дата" DESC, "ID_записи" DESC
      `).all(id);

      const revisions = db.prepare(`
        SELECT "ID_редакции" as id, "Версия" as version, "Файл" as filePath, "Оригинальное_имя" as originalName,
               "Размер" as size, "MIME" as mime, "Комментарий" as comment, "Автор" as author, "Создано" as createdAt
        FROM "Редакция_ПТО" WHERE "ID_документа" = ? ORDER BY "Версия" DESC, "ID_редакции" DESC
      `).all(id).map((row) => ({
        ...row,
        file: row.filePath ? `/api/files/revision/${row.id}` : null
      }));

      ok(res, { data: { ...present(doc), history, revisions } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/pto', upload.single('docFile'), asyncHandler(async (req, res) => {
    assertManagePto(req.user);
    const fields = parseDocFields(req.body);
    const meta = fileMeta(req.file);

    try {
      if (fields.objectId) assertObjectAccess(db, req.user, fields.objectId);

      const result = db.prepare(`
        INSERT INTO "Документ_ПТО" (
          "Тип", "Название", "ID_объекта", "Шифр", "Раздел_проекта", "Статус", "Срок", "Ответственный",
          "Текст", "Файл", "Оригинальное_имя", "Размер", "MIME", "ID_автора", "Версия", "Актуализирован", "updated_at"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, date('now', 'localtime'), datetime('now', 'localtime'))
      `).run(
        fields.type, fields.title, fields.objectId, fields.cipher, fields.projectSection, fields.status,
        fields.dueDate, fields.responsible, fields.content,
        meta ? meta.storedPath : null, meta ? meta.originalName : null, meta ? meta.size : null, meta ? meta.mime : null,
        req.user.id
      );

      const documentId = result.lastInsertRowid;

      addHistory(db, documentId, 'Создан', {
        author: req.user.fullName,
        statusTo: fields.status,
        version: 1,
        comment: text(req.body.comment, { field: 'Комментарий', max: 500 })
      });

      if (meta) {
        addRevision(db, documentId, {
          version: 1, file: meta.storedPath, originalName: meta.originalName, size: meta.size, mime: meta.mime,
          comment: 'Первая редакция', author: req.user.fullName
        });
      }

      ensureDocumentText(db, documentId);
      indexDocument(db, documentId);

      if (fields.responsible) {
        const recipients = recipientsFor(db, fields.responsible);
        notifyRecipients(db, recipients, {
          type: NOTIFICATION_TYPES.DOC_ASSIGNED,
          text: `Назначен ответственный по документу «${fields.title}»`,
          link: `pto:${documentId}`,
          key: `assigned:${documentId}:${Date.now()}`
        });
      }

      writeAudit(db, {
        user: req.user,
        action: 'Создание документа ПТО',
        entity: 'document',
        entityId: documentId,
        objectId: fields.objectId,
        result: 'success',
        ip: req.ip,
        details: { type: fields.type, title: fields.title }
      });

      ok(res, { data: { id: documentId } });
    } catch (error) {
      if (meta) removeStoredQuietly(meta.storedPath);
      throw error;
    }
  }));

  router.put('/pto/:id', upload.single('docFile'), asyncHandler(async (req, res) => {
    assertManagePto(req.user);

    const id = parseId(req.params.id, { field: 'Документ' });
    const fields = parseDocFields(req.body);
    const meta = fileMeta(req.file);

    try {
      const existing = getDoc(db, id);
      assertDocAccess(db, req.user, existing);
      if (fields.objectId) assertObjectAccess(db, req.user, fields.objectId);

      const newRevision = Boolean(meta) || String(req.body.newRevision || '') === 'true';
      const version = newRevision ? Number(existing.version || 1) + 1 : Number(existing.version || 1);
      const statusChanged = existing.status !== fields.status;

      db.prepare(`
        UPDATE "Документ_ПТО"
        SET "Тип" = ?, "Название" = ?, "ID_объекта" = ?, "Шифр" = ?, "Раздел_проекта" = ?, "Статус" = ?,
            "Срок" = ?, "Ответственный" = ?, "Текст" = ?, "Файл" = ?, "Оригинальное_имя" = ?,
            "Размер" = ?, "MIME" = ?, "Версия" = ?, "Актуализирован" = date('now', 'localtime'),
            "updated_at" = datetime('now', 'localtime')
        WHERE "ID_документа" = ?
      `).run(
        fields.type, fields.title, fields.objectId, fields.cipher, fields.projectSection, fields.status,
        fields.dueDate, fields.responsible, fields.content,
        meta ? meta.storedPath : existing.filePath,
        meta ? meta.originalName : existing.originalName,
        meta ? meta.size : existing.size,
        meta ? meta.mime : existing.mime,
        version, id
      );

      if (statusChanged) {
        addHistory(db, id, 'Смена статуса', {
          author: req.user.fullName,
          statusFrom: existing.status,
          statusTo: fields.status,
          version,
          comment: text(req.body.comment, { field: 'Комментарий', max: 500 })
        });

        notifyStatusChange(db, { ...existing, ID_документа: id }, {
          statusFrom: existing.status,
          statusTo: fields.status,
          comment: req.body.comment,
          actor: req.user
        });
      }

      if (newRevision) {
        addRevision(db, id, {
          version,
          file: meta ? meta.storedPath : null,
          originalName: meta ? meta.originalName : existing.originalName,
          size: meta ? meta.size : existing.size,
          mime: meta ? meta.mime : existing.mime,
          comment: text(req.body.comment, { field: 'Комментарий', max: 500 }) || (meta ? 'Заменён файл документа' : 'Новая редакция'),
          author: req.user.fullName
        });

        addHistory(db, id, 'Новая редакция', {
          author: req.user.fullName,
          version,
          comment: text(req.body.comment, { field: 'Комментарий', max: 500 })
        });
      }

      if (!statusChanged && !newRevision) {
        addHistory(db, id, 'Изменён', { author: req.user.fullName, version });
      }

      ensureDocumentText(db, id, { force: true });
      indexDocument(db, id);

      writeAudit(db, {
        user: req.user,
        action: 'Изменение документа ПТО',
        entity: 'document',
        entityId: id,
        objectId: fields.objectId,
        result: 'success',
        ip: req.ip,
        details: { version, statusChanged, newRevision }
      });

      ok(res, { data: { id, version } });
    } catch (error) {
      if (meta) removeStoredQuietly(meta.storedPath);
      throw error;
    }
  }));

  router.patch('/pto/:id/status', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Документ' });
      const status = oneOf(req.body.status, PTO_STATUSES, { field: 'Статус' });
      const comment = text(req.body.comment, { field: 'Комментарий', max: 500 });

      const existing = getDoc(db, id);
      assertDocAccess(db, req.user, existing);

      if (existing.status === status) throw badRequest('Документ уже в этом статусе');

      db.prepare(`
        UPDATE "Документ_ПТО"
        SET "Статус" = ?, "Актуализирован" = date('now', 'localtime'), "updated_at" = datetime('now', 'localtime')
        WHERE "ID_документа" = ?
      `).run(status, id);

      addHistory(db, id, 'Смена статуса', {
        author: req.user.fullName,
        statusFrom: existing.status,
        statusTo: status,
        version: existing.version,
        comment
      });

      notifyStatusChange(db, { ...existing, ID_документа: id }, {
        statusFrom: existing.status,
        statusTo: status,
        comment,
        actor: req.user
      });

      writeAudit(db, {
        user: req.user,
        action: 'Смена статуса документа',
        entity: 'document',
        entityId: id,
        objectId: existing.objectId,
        result: 'success',
        ip: req.ip,
        details: { from: existing.status, to: status }
      });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.delete('/pto/:id', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Документ' });

      const existing = getDoc(db, id);
      assertDocAccess(db, req.user, existing);

      if (!isAdmin(req.user) && existing.authorId && existing.authorId !== req.user.id) {
        throw conflict('Удалить документ другого автора может только администратор');
      }

      const revisions = db.prepare('SELECT "Файл" as file FROM "Редакция_ПТО" WHERE "ID_документа" = ?').all(id);
      const files = new Set([existing.filePath, ...revisions.map((row) => row.file)].filter(Boolean));

      db.prepare('DELETE FROM "Документ_ПТО" WHERE "ID_документа" = ?').run(id);

      for (const file of files) removeStoredQuietly(file);
      removeIndex(db, 'document', id);

      writeAudit(db, {
        user: req.user,
        action: 'Удаление документа ПТО',
        entity: 'document',
        entityId: id,
        objectId: existing.objectId,
        result: 'success',
        ip: req.ip,
        details: { title: existing.title, files: files.size }
      });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createPtoRouter;
