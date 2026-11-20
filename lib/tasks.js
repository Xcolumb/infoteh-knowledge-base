import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { assertTaskAccess, assertObjectAccess, isLead, isAdmin, objectScopeClause } from './permissions.js';
import { id, isoDate, oneOf, text } from './validate.js';
import { createNotification } from './notifications.js';

export const priorities = ['Низкий', 'Обычный', 'Высокий', 'Срочный'];
export const statuses = ['Новая', 'В работе', 'На проверке', 'Выполнена', 'Отменена'];
const closed = ['Выполнена', 'Отменена'];
const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Saratov', year: 'numeric', month: '2-digit', day: '2-digit' });
const base = ` FROM Задача t JOIN Объект o ON o.ID_объекта=t.objectId
  LEFT JOIN Сотрудник a ON a.ID_сотрудника=t.assigneeId JOIN Сотрудник c ON c.ID_сотрудника=t.creatorId`;
const columns = 't.*, o.Название AS objectName, a.ФИО AS assignee, c.ФИО AS creator';
const metricSql = {
  active: "t.status NOT IN ('Выполнена','Отменена')",
  overdue: "t.dueDate < ? AND t.status NOT IN ('Выполнена','Отменена')",
  review: "t.status='На проверке'", done: "t.status='Выполнена'"
};
const sorts = { due: 't.dueDate IS NULL, t.dueDate', updated: 't.updatedAt DESC', title: 't.title COLLATE NOCASE',
  priority: "CASE t.priority WHEN 'Срочный' THEN 0 WHEN 'Высокий' THEN 1 WHEN 'Обычный' THEN 2 ELSE 3 END" };

export function fieldsOnly(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) {
    throw badRequest('Недопустимые поля запроса');
  }
}

export function listTasks(db, user, query, summary = false) {
  assertTaskAccess(user);
  const scope = objectScopeClause(db, user, 't.objectId');
  let sql = base + ' WHERE 1=1' + scope.clause;
  const args = [...scope.params];
  const filter = (condition, value) => { sql += ' AND ' + condition; args.push(value); };
  if (query.scope === 'mine') filter('t.assigneeId=?', user.id);
  else if (query.scope === 'created') filter('t.creatorId=?', user.id);
  if (query.objectId) filter('t.objectId=?', id(query.objectId));
  if (query.status) filter('t.status=?', oneOf(query.status, statuses));
  if (query.priority) filter('t.priority=?', oneOf(query.priority, priorities));
  if (query.q) {
    const q = text(query.q, { max: 200 });
    if (q) {
      // SQLite без ICU приводит к нижнему регистру только ASCII.
      filter("instr(task_fold(t.title || ' ' || t.description),?)>0", q.toLocaleLowerCase('ru'));
    }
  }
  const today = clock.format(new Date());
  if (summary) {
    const counts = Object.entries(metricSql).map(([key, expr]) => `count(CASE WHEN ${expr} THEN 1 END) AS ${key}`);
    return db.prepare('SELECT ' + counts.join(',') + sql).get(today, ...args);
  }
  if (query.metric) {
    const key = oneOf(query.metric, Object.keys(metricSql));
    sql += ' AND ' + metricSql[key];
    if (key === 'overdue') args.push(today);
  }
  const sort = sorts[oneOf(query.sort || 'due', Object.keys(sorts))];
  const limit = Math.min(id(query.limit ?? 40), 100);
  const offset = id(query.page ?? 1) - 1;
  const total = db.prepare('SELECT count(*) AS n' + sql).get(...args).n;
  const rows = db.prepare('SELECT ' + columns + sql + ' ORDER BY ' + sort + ', t.id DESC LIMIT ? OFFSET ?').all(...args, limit, offset * limit);
  return { data: rows.map(r => ({ ...r, overdue: !!r.dueDate && r.dueDate < today && !closed.includes(r.status) })), total };
}

const transitions = [
  ['Новая','В работе','start','Начать работу','execute'],
  ['В работе','На проверке','submit','Передать на проверку','execute'],
  ['На проверке','Выполнена','accept','Принять результат','manage'],
  ['На проверке','В работе','return','Вернуть на доработку','manage']
];
export function capabilities(user, task) {
  const active = task && !closed.includes(task.status);
  const manage = isAdmin(user) || isLead(user) || task.creatorId === user.id;
  const execute = task.assigneeId != null && (isAdmin(user) || (user.role === 'Инженер ПТО' && task.assigneeId === user.id));
  const actions = transitions.filter(([from,,,, who]) => task.status === from && (who === 'manage' ? manage : execute))
    .map(([from,to,key,label]) => ({ key, label, to }));
  if (task.status === 'Новая' && task.assigneeId == null && user.role === 'Инженер ПТО') {
    actions.push({ key: 'claim', label: 'Взять в работу', to: 'В работе' });
  }
  if (active && manage) actions.push({ key: 'cancel', label: 'Отменить задачу', to: 'Отменена' });
  return { edit: !!active && manage, comment: !!active && (manage || execute), actions };
}

export function taskById(db, user, taskId) {
  assertTaskAccess(user);
  const scope = objectScopeClause(db, user, 't.objectId');
  const task = db.prepare('SELECT ' + columns + base + ' WHERE t.id=?' + scope.clause).get(id(taskId), ...scope.params);
  if (!task) throw notFound();
  return task;
}

export function candidates(db, objectId) {
  return db.prepare(`SELECT s.ID_сотрудника AS id, s.ФИО AS name FROM Сотрудник s
    JOIN Доступ_объект a USING (ID_сотрудника)
    WHERE a.ID_объекта=? AND s.Должность='Инженер ПТО' AND s.Заблокирован=0 ORDER BY s.ФИО,s.ID_сотрудника`).all(objectId);
}

export function taskFields(db, user, body, objectId, existing = {}) {
  assertObjectAccess(db, user, objectId);
  const row = { ...existing, ...body };
  const title = text(row.title, { required: true, max: 240, field: 'Название' });
  const description = text(row.description, { max: 10000, field: 'Описание' }) || '';
  const assigneeId = id(row.assigneeId, { field: 'Исполнитель', required:false });
  if (assigneeId != null && (!existing.id || Object.hasOwn(body,'assigneeId'))) {
    if (!candidates(db, objectId).some(person => person.id === assigneeId)) throw badRequest('Исполнитель недоступен для этого объекта');
  }
  const dueDate = isoDate(row.dueDate, { field: 'Срок' });
  if (dueDate && new Date(dueDate + 'T00:00:00Z').toISOString().slice(0,10) !== dueDate) throw badRequest('Некорректный срок');
  const priority = oneOf(row.priority ?? 'Обычный', priorities);
  const documentId = id(row.documentId, { required: false });
  const remarkId = id(row.remarkId, { required: false });
  if (documentId && remarkId) throw badRequest('Выберите одну связанную запись');
  if (documentId && !db.prepare('SELECT 1 FROM Документ_ПТО WHERE ID_документа=? AND ID_объекта=?').get(documentId,objectId)) throw notFound();
  if (remarkId && !db.prepare('SELECT 1 FROM Замечание WHERE ID_замечания=? AND ID_объекта=?').get(remarkId,objectId)) throw notFound();
  return { title, description, assigneeId, dueDate, priority, documentId, remarkId };
}

export function checkVersion(task, value) {
  if (task.version !== id(value, { field: 'Версия' })) throw conflict('Карточка уже изменилась. Обновите её перед сохранением.');
}
export function requireAction(allowed) {
  if (!allowed) throw forbidden('Действие с этой задачей недоступно');
}
export function history(db, taskId, user, event, before = null, after = null, reason = null) {
  db.prepare('INSERT INTO История_задачи(taskId,actorId,event,beforeValue,afterValue,reason) VALUES (?,?,?,?,?,?)')
    .run(taskId,user.id,event,before,after,reason);
}
export function notifyTask(db, task, user, event, recipients) {
  for (const userId of new Set(recipients)) {
    if (event === 'Изменён срок' && userId === user.id) continue;
    createNotification(db, { userId, objectId: task.objectId, type: event, text: event + ' · ' + task.title,
      link: 'task:' + task.id, key: `task:${task.id}:${task.version}:${event}`, strict: true });
  }
}
