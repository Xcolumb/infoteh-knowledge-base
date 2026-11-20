import express from 'express';
import { ok } from '../lib/middleware.js';
import { badRequest } from '../lib/errors.js';
import { requirePtoManager, assertObjectAccess } from '../lib/permissions.js';
import { id, text } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { capabilities, candidates, checkVersion, fieldsOnly, history, listTasks, notifyTask,
  priorities, requireAction, statuses, taskById, taskFields } from '../lib/tasks.js';

const editable = ['title','description','assigneeId','dueDate','priority','documentId','remarkId'];
const labels = { title:'Название', description:'Описание', assigneeId:'Исполнитель', dueDate:'Срок',
  priority:'Приоритет', documentId:'Связанный документ', remarkId:'Связанное замечание' };
const events = { start:'Работа начата', submit:'Задача на проверке', accept:'Результат принят',
  return:'Возврат на доработку', cancel:'Задача отменена' };

export function createTasksRouter({ db }) {
  db.function('task_fold', { deterministic: true }, value => String(value ?? '').toLocaleLowerCase('ru'));
  const router = express.Router();
  router.use(requirePtoManager);

  router.get('/', (req,res) => ok(res,listTasks(db,req.user,req.query)));
  router.get('/summary', (req,res) => ok(res,{ data:listTasks(db,req.user,req.query,true) }));
  router.get('/meta', (req,res) => ok(res,{ priorities,statuses }));
  router.get('/assignees', (req,res) => {
    const object = id(req.query.objectId);
    assertObjectAccess(db,req.user,object);
    ok(res,{ data:candidates(db,object) });
  });
  router.get('/targets', (req,res) => {
    const object = id(req.query.objectId);
    assertObjectAccess(db,req.user,object);
    const docs = db.prepare('SELECT ID_документа AS id, Название AS title FROM Документ_ПТО WHERE ID_объекта=? ORDER BY Название').all(object);
    const remarks = db.prepare('SELECT ID_замечания AS id, Описание AS title FROM Замечание WHERE ID_объекта=? ORDER BY id DESC').all(object);
    ok(res,{ docs,remarks });
  });

  function audit(req,task,action) {
    writeAudit(db,{ user:req.user,action,entity:'task',entityId:task.id,objectId:task.objectId,ip:req.ip });
  }
  router.post('/', (req,res) => {
    fieldsOnly(req.body,[...editable,'objectId']);
    const task = db.transaction(() => {
      const objectId = id(req.body.objectId);
      const values = taskFields(db,req.user,req.body,objectId);
      const result = db.prepare(`INSERT INTO Задача(objectId,creatorId,assigneeId,title,description,dueDate,priority,documentId,remarkId)
        VALUES (@objectId,@creatorId,@assigneeId,@title,@description,@dueDate,@priority,@documentId,@remarkId)`)
        .run({ ...values,objectId,creatorId:req.user.id });
      const created = taskById(db,req.user,result.lastInsertRowid);
      history(db,created.id,req.user,'Создана задача',null,created.assignee);
      notifyTask(db,created,req.user,'Назначена задача',[created.assigneeId]);
      audit(req,created,'Создание задачи');
      return created;
    }).immediate();
    ok(res,{ data:task });
  });

  router.get('/:id', (req,res) => {
    const task = taskById(db,req.user,req.params.id);
    const linked = task.documentId
      ? db.prepare('SELECT Название AS title FROM Документ_ПТО WHERE ID_документа=? AND ID_объекта=?').get(task.documentId,task.objectId)
      : db.prepare('SELECT Описание AS title FROM Замечание WHERE ID_замечания=? AND ID_объекта=?').get(task.remarkId,task.objectId);
    ok(res,{ data:{ ...task, linkedTitle:linked?.title, permissions:capabilities(req.user,task) } });
  });
  router.patch('/:id', (req,res) => {
    const updated = db.transaction(() => {
      const task = taskById(db,req.user,req.params.id);
      requireAction(capabilities(req.user,task).edit);
      fieldsOnly(req.body,[...editable,'version']);
      checkVersion(task,req.body.version);
      const values = taskFields(db,req.user,req.body,task.objectId,task);
      const changes = editable.filter(k => task[k] !== values[k]);
      if (!changes.length) return task;
      const reassigned = changes.includes('assigneeId');
      const status = reassigned ? 'Новая' : task.status;
      db.prepare(`UPDATE Задача SET title=@title,description=@description,assigneeId=@assigneeId,dueDate=@dueDate,
        priority=@priority,documentId=@documentId,remarkId=@remarkId,status=@status,version=version+1,
        updatedAt=CURRENT_TIMESTAMP WHERE id=@id`).run({ ...values,status,id:task.id });
      const next = taskById(db,req.user,task.id);
      for (const field of changes) {
        const key = field === 'assigneeId' ? 'assignee' : field;
        history(db,task.id,req.user,labels[field],task[key],next[key]);
      }
      if (next.status !== task.status) history(db,task.id,req.user,'Статус',task.status,next.status,'Смена исполнителя');
      if (reassigned) notifyTask(db,next,req.user,'Изменён исполнитель',[next.assigneeId]);
      if (changes.includes('dueDate')) notifyTask(db,next,req.user,'Изменён срок',[next.creatorId,next.assigneeId]);
      audit(req,next,'Изменение задачи');
      return next;
    }).immediate();
    ok(res,{ data:updated });
  });
  router.post('/:id/transitions', (req,res) => {
    const updated = db.transaction(() => {
      const task = taskById(db,req.user,req.params.id);
      fieldsOnly(req.body,['action','reason','version']);
      if (!Object.hasOwn(events,req.body.action)) throw badRequest('Неизвестный переход');
      const rights = capabilities(req.user,task);
      requireAction(rights.edit || rights.comment);
      checkVersion(task,req.body.version);
      const action = rights.actions.find(a => a.key === req.body.action);
      requireAction(action);
      const reason = text(req.body.reason,{ required:action.key === 'return',max:2000,field:'Пояснение' });
      db.prepare('UPDATE Задача SET status=?,version=version+1,updatedAt=CURRENT_TIMESTAMP WHERE id=?').run(action.to,task.id);
      const next = taskById(db,req.user,task.id);
      history(db,task.id,req.user,events[action.key],task.status,next.status,reason);
      if (action.key === 'submit') notifyTask(db,next,req.user,events.submit,[task.creatorId]);
      if (['accept','return'].includes(action.key)) notifyTask(db,next,req.user,events[action.key],[task.assigneeId]);
      audit(req,next,events[action.key]);
      return next;
    }).immediate();
    ok(res,{ data:updated });
  });
  router.get('/:id/comments', (req,res) => {
    const task = taskById(db,req.user,req.params.id);
    ok(res,{ data:db.prepare(`SELECT c.id,c.text,c.createdAt,s.ФИО AS author FROM Комментарий_задачи c
      JOIN Сотрудник s ON s.ID_сотрудника=c.authorId WHERE c.taskId=? ORDER BY c.id`).all(task.id) });
  });
  router.post('/:id/comments', (req,res) => {
    const commentId = db.transaction(() => {
      const task = taskById(db,req.user,req.params.id);
      requireAction(capabilities(req.user,task).comment);
      fieldsOnly(req.body,['text']);
      const value = text(req.body.text,{ required:true,max:5000,field:'Комментарий' });
      const result = db.prepare('INSERT INTO Комментарий_задачи(taskId,authorId,text) VALUES (?,?,?)').run(task.id,req.user.id,value);
      audit(req,task,'Комментарий к задаче');
      return result.lastInsertRowid;
    }).immediate();
    ok(res,{ data:{ id:commentId } });
  });
  router.get('/:id/history', (req,res) => {
    const task = taskById(db,req.user,req.params.id);
    ok(res,{ data:db.prepare(`SELECT h.id,h.event,h.beforeValue,h.afterValue,h.reason,h.createdAt,
      COALESCE(s.ФИО,'Система') AS actor FROM История_задачи h LEFT JOIN Сотрудник s ON s.ID_сотрудника=h.actorId
      WHERE h.taskId=? ORDER BY h.id DESC`).all(task.id) });
  });
  return router;
}
