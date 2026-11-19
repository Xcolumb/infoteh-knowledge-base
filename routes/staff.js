import express from 'express';
import bcrypt from 'bcryptjs';
import { asyncHandler } from '../lib/errors.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';
import { assertAdmin } from '../lib/permissions.js';
import { id as parseId, oneOf, password as validatePassword, text } from '../lib/validate.js';
import { ROLES } from '../lib/constants.js';
import { writeAudit } from '../lib/audit.js';
import { getEmployeeObjectIds, setEmployeeObjectAccess } from '../lib/permissions.js';

function activeAdminCount(db) {
  return db.prepare(`SELECT COUNT(*) as count FROM "Сотрудник" WHERE "Должность" = 'Администратор' AND "Заблокирован" = 0`).get().count;
}

export function createStaffRouter({ db }) {
  const router = express.Router();

  // Проверка администратора вынесена в отдельный middleware и применяется
  // к каждому маршруту, чтобы не блокировать остальные /api-маршруты.
  const adminOnly = (req, res, next) => {
    try {
      assertAdmin(req.user);
      next();
    } catch (error) {
      next(error);
    }
  };

  router.get('/sotrudniki', adminOnly, (req, res) => {
    const rows = db.prepare(`
      SELECT "ID_сотрудника" as id, "Табельный_номер" as tabNumber, "ФИО" as fullName,
             "Должность" as role, "Демо" as demo, "Заблокирован" as blocked,
             "Пароль_обновлён" as passwordUpdatedAt
      FROM "Сотрудник"
      ORDER BY "ID_сотрудника"
    `).all();

    ok(res, {
      data: rows.map((row) => ({ ...row, demo: Boolean(row.demo), blocked: Boolean(row.blocked), objectIds: getEmployeeObjectIds(db, row.id) }))
    });
  });

  router.post('/sotrudniki', adminOnly, asyncHandler(async (req, res) => {
    const fullName = text(req.body.fullName, { field: 'ФИО', required: true, max: 150 });
    const tabNumber = text(req.body.tabNumber, { field: 'Табельный номер', required: true, max: 40 });
    const role = oneOf(req.body.role, ROLES, { field: 'Должность' });
    const rawPassword = String(req.body.password || '');

    validatePassword(rawPassword, { tabNumber });

    const exists = db.prepare('SELECT 1 FROM "Сотрудник" WHERE "Табельный_номер" = ?').get(tabNumber);
    if (exists) throw conflict('Сотрудник с таким табельным номером уже существует');

    const hash = await bcrypt.hash(rawPassword, 10);
    const result = db.prepare(`
      INSERT INTO "Сотрудник" ("Табельный_номер", "Пароль", "ФИО", "Должность", "Демо", "Пароль_обновлён")
      VALUES (?, ?, ?, ?, 0, datetime('now', 'localtime'))
    `).run(tabNumber, hash, fullName, role);

    if (Array.isArray(req.body.objectIds)) {
      setEmployeeObjectAccess(db, result.lastInsertRowid, req.body.objectIds.map(Number).filter(Number.isInteger));
    }

    writeAudit(db, {
      user: req.user,
      action: 'Создание сотрудника',
      entity: 'employee',
      entityId: result.lastInsertRowid,
      result: 'success',
      ip: req.ip,
      details: { tabNumber, role }
    });

    ok(res, { data: { id: result.lastInsertRowid, tabNumber, fullName, role } });
  }));

  router.put('/sotrudniki/:id/role', adminOnly, (req, res, next) => {
    try {
      const employeeId = parseId(req.params.id, { field: 'Сотрудник' });
      const role = oneOf(req.body.role, ROLES, { field: 'Должность' });

      const employee = db.prepare('SELECT "ID_сотрудника" as id, "Должность" as role FROM "Сотрудник" WHERE "ID_сотрудника" = ?').get(employeeId);
      if (!employee) throw notFound('Сотрудник не найден');

      if (employeeId === req.user.id && role !== 'Администратор') {
        throw forbidden('Нельзя снять роль администратора с самого себя');
      }

      if (employee.role === 'Администратор' && role !== 'Администратор' && activeAdminCount(db) <= 1) {
        throw conflict('В системе должен остаться хотя бы один активный администратор');
      }

      db.prepare('UPDATE "Сотрудник" SET "Должность" = ? WHERE "ID_сотрудника" = ?').run(role, employeeId);

      writeAudit(db, {
        user: req.user,
        action: 'Изменение должности',
        entity: 'employee',
        entityId: employeeId,
        result: 'success',
        ip: req.ip,
        details: { from: employee.role, to: role }
      });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.put('/sotrudniki/:id/password', adminOnly, asyncHandler(async (req, res) => {
    const employeeId = parseId(req.params.id, { field: 'Сотрудник' });
    const employee = db.prepare('SELECT "ID_сотрудника" as id, "Табельный_номер" as tabNumber FROM "Сотрудник" WHERE "ID_сотрудника" = ?').get(employeeId);

    if (!employee) throw notFound('Сотрудник не найден');

    const valid = validatePassword(String(req.body.password || ''), { tabNumber: employee.tabNumber });
    const hash = await bcrypt.hash(valid, 10);

    db.prepare('UPDATE "Сотрудник" SET "Пароль" = ?, "Пароль_обновлён" = datetime(\'now\', \'localtime\') WHERE "ID_сотрудника" = ?')
      .run(hash, employeeId);

    writeAudit(db, {
      user: req.user,
      action: 'Сброс пароля администратором',
      entity: 'employee',
      entityId: employeeId,
      result: 'success',
      ip: req.ip
    });

    ok(res, { message: 'Пароль сброшен' });
  }));

  router.put('/sotrudniki/:id/access', adminOnly, (req, res, next) => {
    try {
      const employeeId = parseId(req.params.id, { field: 'Сотрудник' });
      const employee = db.prepare('SELECT "ID_сотрудника" FROM "Сотрудник" WHERE "ID_сотрудника" = ?').get(employeeId);
      if (!employee) throw notFound('Сотрудник не найден');

      if (!Array.isArray(req.body.objectIds)) throw badRequest('objectIds должен быть массивом');

      const objectIds = req.body.objectIds.map(Number).filter((value) => Number.isInteger(value) && value > 0);
      const validObjects = db.prepare('SELECT "ID_объекта" as id FROM "Объект"').all().map((row) => row.id);
      const unknown = objectIds.filter((value) => !validObjects.includes(value));
      if (unknown.length) throw badRequest(`Неизвестные объекты: ${unknown.join(', ')}`);

      setEmployeeObjectAccess(db, employeeId, objectIds);

      writeAudit(db, {
        user: req.user,
        action: 'Изменение доступа к объектам',
        entity: 'employee',
        entityId: employeeId,
        result: 'success',
        ip: req.ip,
        details: { objectIds }
      });

      ok(res, { objectIds });
    } catch (error) {
      next(error);
    }
  });

  router.put('/sotrudniki/:id/block', adminOnly, (req, res, next) => {
    try {
      const employeeId = parseId(req.params.id, { field: 'Сотрудник' });
      const blocked = req.body.blocked === true || req.body.blocked === '1' || req.body.blocked === 'true';

      if (employeeId === req.user.id) throw forbidden('Нельзя заблокировать самого себя');

      const employee = db.prepare('SELECT "ID_сотрудника" as id, "Должность" as role FROM "Сотрудник" WHERE "ID_сотрудника" = ?').get(employeeId);
      if (!employee) throw notFound('Сотрудник не найден');

      if (blocked && employee.role === 'Администратор' && activeAdminCount(db) <= 1) {
        throw conflict('В системе должен остаться хотя бы один активный администратор');
      }

      db.prepare('UPDATE "Сотрудник" SET "Заблокирован" = ? WHERE "ID_сотрудника" = ?').run(blocked ? 1 : 0, employeeId);

      writeAudit(db, {
        user: req.user,
        action: blocked ? 'Блокировка сотрудника' : 'Разблокировка сотрудника',
        entity: 'employee',
        entityId: employeeId,
        result: 'success',
        ip: req.ip
      });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sotrudniki/:id', adminOnly, (req, res, next) => {
    try {
      const employeeId = parseId(req.params.id, { field: 'Сотрудник' });

      if (employeeId === req.user.id) throw forbidden('Нельзя удалить самого себя');

      const employee = db.prepare('SELECT "ID_сотрудника" as id, "Должность" as role FROM "Сотрудник" WHERE "ID_сотрудника" = ?').get(employeeId);
      if (!employee) throw notFound('Сотрудник не найден');

      if (employee.role === 'Администратор' && activeAdminCount(db) <= 1) {
        throw conflict('В системе должен остаться хотя бы один активный администратор');
      }

      const linked = db.prepare('SELECT COUNT(*) as count FROM "Статья" WHERE "ID_автора" = ?').get(employeeId).count;
      if (linked > 0) {
        throw conflict(`Невозможно удалить: сотрудник указан автором ${linked} статей. Заблокируйте учётную запись вместо удаления.`);
      }

      db.prepare('DELETE FROM "Сотрудник" WHERE "ID_сотрудника" = ?').run(employeeId);

      writeAudit(db, {
        user: req.user,
        action: 'Удаление сотрудника',
        entity: 'employee',
        entityId: employeeId,
        result: 'success',
        ip: req.ip
      });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.get('/audit', adminOnly, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const rows = db.prepare(`
      SELECT "ID_записи" as id, "Дата" as date, "ID_сотрудника" as userId, "ФИО" as fullName,
             "Действие" as action, "Сущность" as entity, "ID_сущности" as entityId,
             "ID_объекта" as objectId, "Результат" as result, "IP" as ip, "Детали" as details
      FROM "Аудит"
      ORDER BY "ID_записи" DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    const total = db.prepare('SELECT COUNT(*) as count FROM "Аудит"').get().count;

    ok(res, { data: rows, total, limit, offset });
  });

  return router;
}

export default createStaffRouter;
