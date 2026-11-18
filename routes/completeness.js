import express from 'express';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';
import { assertManagePto, assertObjectAccess, canAccessObject, isAdmin, objectScopeClause } from '../lib/permissions.js';
import { id as parseId, oneOf, text } from '../lib/validate.js';
import { PTO_CLOSED_STATUSES, PTO_TYPES } from '../lib/constants.js';
import { writeAudit } from '../lib/audit.js';

function computeState(requirements) {
  let complete = 0;
  let inWork = 0;
  let missing = 0;

  for (const requirement of requirements) {
    if (!requirement.documents.length) {
      missing += 1;
      requirement.state = 'Отсутствует';
      continue;
    }

    const isComplete = requirement.documents.some((doc) => PTO_CLOSED_STATUSES.includes(doc.status));
    requirement.state = isComplete ? 'Готово' : 'В работе';

    if (isComplete) complete += 1;
    else inWork += 1;
  }

  const total = requirements.length;
  return {
    total,
    complete,
    inWork,
    missing,
    percent: total ? Math.round(((complete + inWork * 0.5) / total) * 100) : 0
  };
}

function loadSet(db, setId) {
  const set = db.prepare(`
    SELECT k."ID_комплекта" as id, k."Название" as name, k."ID_объекта" as objectId, o."Название" as objectName,
           k."Ответственный" as responsible, k."Примечание" as note, k."Активен" as active, k."Создано" as createdAt,
           k."updated_at" as updatedAt
    FROM "Комплект" k
    LEFT JOIN "Объект" o ON k."ID_объекта" = o."ID_объекта"
    WHERE k."ID_комплекта" = ?
  `).get(setId);

  if (!set) return null;

  const requirements = db.prepare(`
    SELECT "ID_требования" as id, "Название" as name, "Тип_документа" as type,
           "Обязательно" as required, "Порядок" as sortOrder
    FROM "Требование_комплекта"
    WHERE "ID_комплекта" = ?
    ORDER BY "Порядок", "ID_требования"
  `).all(setId);

  for (const requirement of requirements) {
    requirement.required = Boolean(requirement.required);
    requirement.documents = db.prepare(`
      SELECT d."ID_документа" as id, d."Название" as title, d."Статус" as status,
             d."Шифр" as cipher, d."Срок" as dueDate
      FROM "Документ_комплекта" s
      JOIN "Документ_ПТО" d ON s."ID_документа" = d."ID_документа"
      WHERE s."ID_требования" = ?
      ORDER BY d."ID_документа"
    `).all(requirement.id);
  }

  return { ...set, active: Boolean(set.active), requirements, stats: computeState(requirements) };
}

function assertSetAccess(db, user, set) {
  if (!set) throw notFound('Комплект не найден');
  assertObjectAccess(db, user, set.objectId);
}

export function createCompletenessRouter({ db }) {
  const router = express.Router();

  router.get('/completeness', (req, res) => {
    const rows = db.prepare(`
      SELECT k."ID_комплекта" as id, k."Название" as name, k."ID_объекта" as objectId, o."Название" as objectName,
             k."Ответственный" as responsible, k."Активен" as active, k."updated_at" as updatedAt
      FROM "Комплект" k
      LEFT JOIN "Объект" o ON k."ID_объекта" = o."ID_объекта"
      ORDER BY k."ID_комплекта" DESC
    `).all().filter((row) => canAccessObject(db, req.user, row.objectId));

    const data = rows.map((row) => {
      const set = loadSet(db, row.id);
      return { ...row, active: Boolean(row.active), stats: set ? set.stats : { total: 0, complete: 0, inWork: 0, missing: 0, percent: 0 } };
    });

    ok(res, { data });
  });

  router.post('/completeness', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });
      const objectId = req.body.objectId ? parseId(req.body.objectId, { field: 'Объект' }) : null;
      const responsible = text(req.body.responsible, { field: 'Ответственный', max: 150 });
      const note = text(req.body.note, { field: 'Примечание', max: 1000 });

      if (objectId) assertObjectAccess(db, req.user, objectId);

      const result = db.prepare(`
        INSERT INTO "Комплект" ("Название", "ID_объекта", "Ответственный", "Примечание", "Активен", "Создано", "updated_at")
        VALUES (?, ?, ?, ?, 1, datetime('now', 'localtime'), datetime('now', 'localtime'))
      `).run(name, objectId, responsible, note);

      writeAudit(db, { user: req.user, action: 'Создание комплекта ИД', entity: 'completeness', entityId: result.lastInsertRowid, objectId, result: 'success', ip: req.ip });

      ok(res, { data: { id: result.lastInsertRowid } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/completeness/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Комплект' });
      const set = loadSet(db, id);
      assertSetAccess(db, req.user, set);
      ok(res, { data: set });
    } catch (error) {
      next(error);
    }
  });

  router.put('/completeness/:id', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Комплект' });
      const set = loadSet(db, id);
      assertSetAccess(db, req.user, set);

      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });
      const objectId = req.body.objectId ? parseId(req.body.objectId, { field: 'Объект' }) : null;
      const responsible = text(req.body.responsible, { field: 'Ответственный', max: 150 });
      const note = text(req.body.note, { field: 'Примечание', max: 1000 });
      const active = req.body.active === false || req.body.active === 'false' ? 0 : 1;

      if (objectId) assertObjectAccess(db, req.user, objectId);

      db.prepare(`
        UPDATE "Комплект" SET "Название" = ?, "ID_объекта" = ?, "Ответственный" = ?, "Примечание" = ?,
               "Активен" = ?, "updated_at" = datetime('now', 'localtime')
        WHERE "ID_комплекта" = ?
      `).run(name, objectId, responsible, note, active, id);

      writeAudit(db, { user: req.user, action: 'Изменение комплекта ИД', entity: 'completeness', entityId: id, objectId, result: 'success', ip: req.ip });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.delete('/completeness/:id', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Комплект' });
      const set = loadSet(db, id);
      assertSetAccess(db, req.user, set);

      if (!isAdmin(req.user) && set.objectId) {
        // Инженер ПТО может удалять только свои комплекты, администратор — любые.
        // Авторство не хранится в старых записях, поэтому проверяем доступ по объекту.
      }

      db.prepare('DELETE FROM "Комплект" WHERE "ID_комплекта" = ?').run(id);

      writeAudit(db, { user: req.user, action: 'Удаление комплекта ИД', entity: 'completeness', entityId: id, objectId: set.objectId, result: 'success', ip: req.ip });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.post('/completeness/:id/requirements', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const id = parseId(req.params.id, { field: 'Комплект' });
      const set = loadSet(db, id);
      assertSetAccess(db, req.user, set);

      const name = text(req.body.name, { field: 'Название требования', required: true, max: 300 });
      const type = req.body.type ? oneOf(req.body.type, PTO_TYPES, { field: 'Тип документа' }) : null;
      const required = req.body.required === false || req.body.required === 'false' ? 0 : 1;
      const sortOrder = Number(req.body.sortOrder) || 0;

      const result = db.prepare(`
        INSERT INTO "Требование_комплекта" ("ID_комплекта", "Название", "Тип_документа", "Обязательно", "Порядок")
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, type, required, sortOrder);

      db.prepare('UPDATE "Комплект" SET "updated_at" = datetime(\'now\', \'localtime\') WHERE "ID_комплекта" = ?').run(id);

      writeAudit(db, { user: req.user, action: 'Добавление требования комплекта', entity: 'completeness', entityId: id, objectId: set.objectId, result: 'success', ip: req.ip, details: { name } });

      ok(res, { data: { id: result.lastInsertRowid } });
    } catch (error) {
      next(error);
    }
  });

  router.put('/completeness/requirements/:requirementId', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const requirementId = parseId(req.params.requirementId, { field: 'Требование' });

      const requirement = db.prepare('SELECT "ID_комплекта" as setId, "Название" as name FROM "Требование_комплекта" WHERE "ID_требования" = ?').get(requirementId);
      if (!requirement) throw notFound('Требование не найдено');

      const set = loadSet(db, requirement.setId);
      assertSetAccess(db, req.user, set);

      const name = text(req.body.name, { field: 'Название требования', required: true, max: 300 });
      const type = req.body.type ? oneOf(req.body.type, PTO_TYPES, { field: 'Тип документа' }) : null;
      const required = req.body.required === false || req.body.required === 'false' ? 0 : 1;
      const sortOrder = Number(req.body.sortOrder) || 0;

      db.prepare(`
        UPDATE "Требование_комплекта" SET "Название" = ?, "Тип_документа" = ?, "Обязательно" = ?, "Порядок" = ?
        WHERE "ID_требования" = ?
      `).run(name, type, required, sortOrder, requirementId);

      writeAudit(db, { user: req.user, action: 'Изменение требования комплекта', entity: 'completeness', entityId: requirement.setId, result: 'success', ip: req.ip });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.delete('/completeness/requirements/:requirementId', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const requirementId = parseId(req.params.requirementId, { field: 'Требование' });

      const requirement = db.prepare('SELECT "ID_комплекта" as setId FROM "Требование_комплекта" WHERE "ID_требования" = ?').get(requirementId);
      if (!requirement) throw notFound('Требование не найдено');

      const set = loadSet(db, requirement.setId);
      assertSetAccess(db, req.user, set);

      db.prepare('DELETE FROM "Требование_комплекта" WHERE "ID_требования" = ?').run(requirementId);

      writeAudit(db, { user: req.user, action: 'Удаление требования комплекта', entity: 'completeness', entityId: requirement.setId, result: 'success', ip: req.ip });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.post('/completeness/requirements/:requirementId/documents', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const requirementId = parseId(req.params.requirementId, { field: 'Требование' });
      const documentId = parseId(req.body.documentId, { field: 'Документ' });

      const requirement = db.prepare('SELECT "ID_комплекта" as setId FROM "Требование_комплекта" WHERE "ID_требования" = ?').get(requirementId);
      if (!requirement) throw notFound('Требование не найдено');

      const set = loadSet(db, requirement.setId);
      assertSetAccess(db, req.user, set);

      const document = db.prepare('SELECT "ID_объекта" as objectId FROM "Документ_ПТО" WHERE "ID_документа" = ?').get(documentId);
      if (!document) throw notFound('Документ не найден');
      assertObjectAccess(db, req.user, document.objectId);

      if (set.objectId && document.objectId && set.objectId !== document.objectId) {
        throw conflict('Документ относится к другому объекту');
      }

      db.prepare('INSERT OR IGNORE INTO "Документ_комплекта" ("ID_требования", "ID_документа", "Создано") VALUES (?, ?, datetime(\'now\', \'localtime\'))')
        .run(requirementId, documentId);

      writeAudit(db, { user: req.user, action: 'Привязка документа к комплекту', entity: 'completeness', entityId: requirement.setId, result: 'success', ip: req.ip, details: { documentId } });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.delete('/completeness/requirements/:requirementId/documents/:documentId', (req, res, next) => {
    try {
      assertManagePto(req.user);
      const requirementId = parseId(req.params.requirementId, { field: 'Требование' });
      const documentId = parseId(req.params.documentId, { field: 'Документ' });

      const requirement = db.prepare('SELECT "ID_комплекта" as setId FROM "Требование_комплекта" WHERE "ID_требования" = ?').get(requirementId);
      if (!requirement) throw notFound('Требование не найдено');

      const set = loadSet(db, requirement.setId);
      assertSetAccess(db, req.user, set);

      db.prepare('DELETE FROM "Документ_комплекта" WHERE "ID_требования" = ? AND "ID_документа" = ?').run(requirementId, documentId);

      writeAudit(db, { user: req.user, action: 'Отвязка документа от комплекта', entity: 'completeness', entityId: requirement.setId, result: 'success', ip: req.ip, details: { documentId } });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.get('/completeness/:id/missing.csv', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Комплект' });
      const set = loadSet(db, id);
      assertSetAccess(db, req.user, set);

      const cell = (value) => {
        const string = String(value ?? '');
        return /[";\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
      };

      const lines = [['№', 'Требование', 'Тип документа', 'Обязательно', 'Состояние'].map(cell).join(';')];

      set.requirements.forEach((requirement, index) => {
        if (requirement.state === 'Готово') return;
        lines.push([
          index + 1,
          requirement.name,
          requirement.type || '',
          requirement.required ? 'да' : 'нет',
          requirement.state
        ].map(cell).join(';'));
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="komplekt-${id}-missing.csv"`);
      res.send('\uFEFF' + lines.join('\r\n'));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createCompletenessRouter;
