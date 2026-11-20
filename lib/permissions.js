import { conflict, forbidden, notFound } from './errors.js';
import { ADMIN_ONLY, CONTENT_MANAGERS, PTO_MANAGERS } from './constants.js';

// Правила доступа собраны в одном месте: сервер — единственный источник решений.
export function isAdmin(user) {
  return Boolean(user) && user.role === 'Администратор';
}

export function isLead(user) {
  return user?.role === 'Руководитель';
}

export function canUseTasks(user) {
  return isAdmin(user) || isLead(user) || user?.role === 'Инженер ПТО';
}

export function assertTaskAccess(user) {
  if (!canUseTasks(user)) throw forbidden('Раздел задач недоступен');
}

export function canCommentRemarks(user) {
  return Boolean(user) && !isLead(user);
}

export function sessionPermissions(user) {
  return { admin: canManageStaff(user), content: canManageContent(user), pto: canManagePto(user),
    tasks: canUseTasks(user), remarkComments: canCommentRemarks(user) };
}

export function canManageContent(user) {
  return Boolean(user) && CONTENT_MANAGERS.includes(user.role);
}

export function canManagePto(user) {
  return Boolean(user) && PTO_MANAGERS.includes(user.role);
}

export function canManageStaff(user) {
  return Boolean(user) && ADMIN_ONLY.includes(user.role);
}

export function assertAdmin(user) {
  if (!isAdmin(user)) throw forbidden('Действие доступно только администратору');
}

export function assertManageContent(user) {
  if (!canManageContent(user)) throw forbidden('Недостаточно прав для управления каталогом');
}

export function assertManagePto(user) {
  if (!canManagePto(user)) throw forbidden('Недостаточно прав для управления документами ПТО');
}

// Список объектов, доступных сотруднику.
// Глобальное чтение объектов не требует записей в «Доступ_объект».
export function getAccessibleObjectIds(db, user) {
  if (!user) return [];

  if (isAdmin(user) || isLead(user)) {
    return db.prepare('SELECT "ID_объекта" as id FROM "Объект" ORDER BY "ID_объекта"').all().map((row) => row.id);
  }

  return db
    .prepare('SELECT "ID_объекта" as id FROM "Доступ_объект" WHERE "ID_сотрудника" = ? ORDER BY "ID_объекта"')
    .all(user.id)
    .map((row) => row.id);
}

export function canAccessObject(db, user, objectId) {
  if (!user) return false;
  if (objectId == null) return isAdmin(user);
  const scope = objectScopeClause(db, user, 'o."ID_объекта"');
  return Boolean(db.prepare(`
    SELECT 1 FROM "Объект" o WHERE o."ID_объекта" = ? ${scope.clause}
  `).get(objectId, ...scope.params));
}

export function assertObjectAccess(db, user, objectId) {
  if (!canAccessObject(db, user, objectId)) throw notFound();
}

// column — SQL-выражение из кода вызывающего модуля.
export function objectScopeClause(db, user, column = 'd."ID_объекта"') {
  if (isAdmin(user)) return { clause: '', params: [] };
  if (isLead(user)) return { clause: ` AND ${column} IN (SELECT ID_объекта FROM Объект)`, params: [] };
  return {
    clause: ` AND ${column} IN (SELECT "ID_объекта" FROM "Доступ_объект" WHERE "ID_сотрудника" = ?)`,
    params: [user?.id ?? null]
  };
}

export function requirePtoManager(req, res, next) {
  assertManagePto(req.user);
  next();
}

export function assertDocumentLink(db, user, documentId, objectId) {
  const doc = db.prepare('SELECT "ID_объекта" AS objectId FROM "Документ_ПТО" WHERE "ID_документа" = ?').get(documentId);
  if (!doc) throw notFound();
  assertObjectAccess(db, user, doc.objectId);
  if (objectId == null || doc.objectId !== objectId) throw conflict('Для связи нужен один общий объект');
}

export function getEmployeeObjectIds(db, employeeId) {
  return db
    .prepare('SELECT "ID_объекта" as id FROM "Доступ_объект" WHERE "ID_сотрудника" = ?')
    .all(employeeId)
    .map((row) => row.id);
}

export function setEmployeeObjectAccess(db, employeeId, objectIds) {
  const clear = db.prepare('DELETE FROM "Доступ_объект" WHERE "ID_сотрудника" = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO "Доступ_объект" ("ID_сотрудника", "ID_объекта") VALUES (?, ?)');

  const run = db.transaction(() => {
    clear.run(employeeId);
    for (const objectId of objectIds) {
      insert.run(employeeId, objectId);
    }
  });

  run();
}
