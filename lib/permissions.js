import { forbidden } from './errors.js';
import { ADMIN_ONLY, CONTENT_MANAGERS, PTO_MANAGERS } from './constants.js';

// Правила доступа собраны в одном месте: сервер — единственный источник решений.
export function isAdmin(user) {
  return Boolean(user) && user.role === 'Администратор';
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
// Администратор видит все объекты; остальные — назначенные в «Доступ_объект».
export function getAccessibleObjectIds(db, user) {
  if (!user) return [];

  if (isAdmin(user)) {
    return db.prepare('SELECT "ID_объекта" as id FROM "Объект" ORDER BY "ID_объекта"').all().map((row) => row.id);
  }

  return db
    .prepare('SELECT "ID_объекта" as id FROM "Доступ_объект" WHERE "ID_сотрудника" = ? ORDER BY "ID_объекта"')
    .all(user.id)
    .map((row) => row.id);
}

export function canAccessObject(db, user, objectId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (objectId === null || objectId === undefined || objectId === '') return true;

  const row = db
    .prepare('SELECT 1 FROM "Доступ_объект" WHERE "ID_сотрудника" = ? AND "ID_объекта" = ?')
    .get(user.id, Number(objectId));

  return Boolean(row);
}

export function assertObjectAccess(db, user, objectId) {
  if (!canAccessObject(db, user, objectId)) {
    throw forbidden('Нет доступа к документам этого объекта');
  }
}

// SQL-фильтр по доступным объектам: возвращает { clause, params }.
// Для администратора фильтр отсутствует.
export function objectScopeClause(db, user, column = 'd."ID_объекта"') {
  if (isAdmin(user)) return { clause: '', params: [] };

  const ids = getAccessibleObjectIds(db, user);
  if (ids.length === 0) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND (${column} IS NULL OR ${column} IN (${ids.map(() => '?').join(', ')}))`,
    params: ids
  };
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
