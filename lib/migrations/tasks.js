// Все изменения привязок входят в транзакцию исходного документа или замечания.
export const taskMigration = {
  name: '007-tasks',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Задача (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objectId INTEGER NOT NULL REFERENCES Объект(ID_объекта) ON DELETE RESTRICT,
        creatorId INTEGER NOT NULL REFERENCES Сотрудник(ID_сотрудника),
        assigneeId INTEGER NOT NULL REFERENCES Сотрудник(ID_сотрудника),
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        dueDate TEXT, priority TEXT NOT NULL CHECK(priority IN ('Низкий','Обычный','Высокий','Срочный')),
        status TEXT NOT NULL DEFAULT 'Новая' CHECK(status IN ('Новая','В работе','На проверке','Выполнена','Отменена')),
        documentId INTEGER REFERENCES Документ_ПТО(ID_документа),
        remarkId INTEGER REFERENCES Замечание(ID_замечания),
        version INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(documentId IS NULL OR remarkId IS NULL)
      );
      CREATE TABLE IF NOT EXISTS Комментарий_задачи (
        id INTEGER PRIMARY KEY, taskId INTEGER NOT NULL REFERENCES Задача(id),
        authorId INTEGER NOT NULL REFERENCES Сотрудник(ID_сотрудника),
        text TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS История_задачи (
        id INTEGER PRIMARY KEY, taskId INTEGER NOT NULL REFERENCES Задача(id),
        actorId INTEGER REFERENCES Сотрудник(ID_сотрудника), event TEXT NOT NULL,
        beforeValue TEXT, afterValue TEXT, reason TEXT, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_task_object ON Задача(objectId,status,dueDate);
      CREATE INDEX IF NOT EXISTS idx_task_assignee ON Задача(assigneeId,status);
      CREATE INDEX IF NOT EXISTS idx_task_creator ON Задача(creatorId);
      CREATE INDEX IF NOT EXISTS idx_task_doc ON Задача(documentId);
      CREATE INDEX IF NOT EXISTS idx_task_remark ON Задача(remarkId);
      CREATE INDEX IF NOT EXISTS idx_task_comments ON Комментарий_задачи(taskId,id);
      CREATE INDEX IF NOT EXISTS idx_task_history ON История_задачи(taskId,id);
    `);
    for (const [table, pk, field] of [['Документ_ПТО','ID_документа','documentId'], ['Замечание','ID_замечания','remarkId']]) {
      for (const [suffix, timing, condition] of [
        ['move','AFTER UPDATE OF ID_объекта','WHEN OLD.ID_объекта IS NOT NEW.ID_объекта'],
        ['delete','BEFORE DELETE','']
      ]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS task_${field}_${suffix} ${timing} ON ${table} ${condition}
          BEGIN
            INSERT INTO История_задачи(taskId,event, beforeValue)
              SELECT id, 'Снята связь', '${table}' FROM Задача WHERE ${field}=OLD.${pk};
            UPDATE Задача SET ${field}=NULL, version=version+1, updatedAt=CURRENT_TIMESTAMP WHERE ${field}=OLD.${pk};
          END;`);
      }
    }
  }
};
