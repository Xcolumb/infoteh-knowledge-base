import express from 'express';
import path from 'path';
import { asyncHandler } from '../lib/errors.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';
import { assertAdmin, assertManageContent, canManageContent } from '../lib/permissions.js';
import { id as parseId, text } from '../lib/validate.js';
import { upload, fileMeta, removeStoredQuietly } from '../lib/files.js';
import { indexArticle, removeIndex } from '../lib/search.js';
import { writeAudit } from '../lib/audit.js';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function articleFileUrl(id, hasFile) {
  return hasFile ? `/api/files/article/${id}` : null;
}

export function createCatalogRouter({ db }) {
  const router = express.Router();

  // --- Виды работ ---

  router.get('/vidy-rabot', (req, res) => {
    const rows = db.prepare('SELECT "ID_вида" as id, "Название" as name, "updated_at" as updatedAt FROM "Виды_работ" ORDER BY "ID_вида"').all();
    ok(res, { data: rows });
  });

  router.post('/vidy-rabot', (req, res, next) => {
    try {
      assertManageContent(req.user);
      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });

      const result = db.prepare('INSERT INTO "Виды_работ" ("Название", "updated_at") VALUES (?, datetime(\'now\', \'localtime\'))').run(name);

      writeAudit(db, { user: req.user, action: 'Создание вида работ', entity: 'vid', entityId: result.lastInsertRowid, result: 'success', ip: req.ip });

      ok(res, { data: { id: result.lastInsertRowid, name } });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(conflict('Вид работ с таким названием уже существует'));
      next(error);
    }
  });

  router.put('/vidy-rabot/:id', (req, res, next) => {
    try {
      assertManageContent(req.user);
      const id = parseId(req.params.id, { field: 'Вид работ' });
      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });

      const existing = db.prepare('SELECT "ID_вида" FROM "Виды_работ" WHERE "ID_вида" = ?').get(id);
      if (!existing) throw notFound('Вид работ не найден');

      db.prepare('UPDATE "Виды_работ" SET "Название" = ?, "updated_at" = datetime(\'now\', \'localtime\') WHERE "ID_вида" = ?').run(name, id);

      ok(res, {});
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return next(conflict('Вид работ с таким названием уже существует'));
      next(error);
    }
  });

  router.delete('/vidy-rabot/:id', (req, res, next) => {
    try {
      assertManageContent(req.user);
      const id = parseId(req.params.id, { field: 'Вид работ' });

      const count = db.prepare('SELECT COUNT(*) as count FROM "Работа" WHERE "ID_вида" = ?').get(id).count;
      if (count > 0) throw conflict(`Невозможно удалить: есть ${count} связанных работ`);

      const result = db.prepare('DELETE FROM "Виды_работ" WHERE "ID_вида" = ?').run(id);
      if (!result.changes) throw notFound('Вид работ не найден');

      writeAudit(db, { user: req.user, action: 'Удаление вида работ', entity: 'vid', entityId: id, result: 'success', ip: req.ip });
      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  // --- Работы ---

  router.get('/raboty', (req, res) => {
    const rows = db.prepare(`
      SELECT r."ID_работы" as id, r."Название" as name, r."ID_вида" as vidId, v."Название" as vidName,
             r."Описание" as description, r."Инструкция" as instruction, r."updated_at" as updatedAt
      FROM "Работа" r
      LEFT JOIN "Виды_работ" v ON r."ID_вида" = v."ID_вида"
      ORDER BY r."ID_работы"
    `).all();

    ok(res, { data: rows });
  });

  router.post('/raboty', (req, res, next) => {
    try {
      assertManageContent(req.user);
      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });
      const vidId = parseId(req.body.vidId, { field: 'Вид работ' });
      const description = text(req.body.description, { field: 'Описание', max: 2000 });
      const instruction = text(req.body.instruction, { field: 'Инструкция', max: 20000 });

      if (!db.prepare('SELECT 1 FROM "Виды_работ" WHERE "ID_вида" = ?').get(vidId)) throw badRequest('Вид работ не найден');

      const result = db.prepare(`
        INSERT INTO "Работа" ("Название", "ID_вида", "Описание", "Инструкция", "updated_at")
        VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
      `).run(name, vidId, description, instruction);

      writeAudit(db, { user: req.user, action: 'Создание работы', entity: 'work', entityId: result.lastInsertRowid, result: 'success', ip: req.ip });
      ok(res, { data: { id: result.lastInsertRowid, name, vidId } });
    } catch (error) {
      next(error);
    }
  });

  router.put('/raboty/:id', (req, res, next) => {
    try {
      assertManageContent(req.user);
      const id = parseId(req.params.id, { field: 'Работа' });
      const name = text(req.body.name, { field: 'Название', required: true, max: 200 });
      const vidId = parseId(req.body.vidId, { field: 'Вид работ' });
      const description = text(req.body.description, { field: 'Описание', max: 2000 });
      const instruction = text(req.body.instruction, { field: 'Инструкция', max: 20000 });

      if (!db.prepare('SELECT 1 FROM "Работа" WHERE "ID_работы" = ?').get(id)) throw notFound('Работа не найдена');
      if (!db.prepare('SELECT 1 FROM "Виды_работ" WHERE "ID_вида" = ?').get(vidId)) throw badRequest('Вид работ не найден');

      db.prepare(`
        UPDATE "Работа" SET "Название" = ?, "ID_вида" = ?, "Описание" = ?, "Инструкция" = ?, "updated_at" = datetime('now', 'localtime')
        WHERE "ID_работы" = ?
      `).run(name, vidId, description, instruction, id);

      writeAudit(db, { user: req.user, action: 'Изменение работы', entity: 'work', entityId: id, result: 'success', ip: req.ip });
      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  router.delete('/raboty/:id', (req, res, next) => {
    try {
      assertManageContent(req.user);
      const id = parseId(req.params.id, { field: 'Работа' });

      const count = db.prepare('SELECT COUNT(*) as count FROM "Статья" WHERE "ID_работы" = ?').get(id).count;
      if (count > 0) throw conflict(`Невозможно удалить: есть ${count} связанных статей`);

      const result = db.prepare('DELETE FROM "Работа" WHERE "ID_работы" = ?').run(id);
      if (!result.changes) throw notFound('Работа не найдена');

      writeAudit(db, { user: req.user, action: 'Удаление работы', entity: 'work', entityId: id, result: 'success', ip: req.ip });
      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  // --- Статьи (каталог знаний) ---

  router.get('/articles', (req, res) => {
    const rows = db.prepare(`
      SELECT s."ID_статьи" as id, s."Название" as title, s."ID_работы" as rabotaId, r."Название" as rabotaName,
             v."Название" as vidName, s."Ключевые_слова" as keywords, s."Дата_публикации" as publishDate,
             s."ID_автора" as authorId, a."ФИО" as authorName, s."Текст_статьи" as content,
             s."Файл" as filePath, s."Оригинальное_имя" as originalName, s."updated_at" as updatedAt
      FROM "Статья" s
      LEFT JOIN "Работа" r ON s."ID_работы" = r."ID_работы"
      LEFT JOIN "Виды_работ" v ON r."ID_вида" = v."ID_вида"
      LEFT JOIN "Сотрудник" a ON s."ID_автора" = a."ID_сотрудника"
      ORDER BY s."Дата_публикации" DESC
    `).all();

    ok(res, {
      data: rows.map((row) => ({
        ...row,
        file: articleFileUrl(row.id, Boolean(row.filePath)),
        canEdit: canManageContent(req.user)
      }))
    });
  });

  router.get('/articles/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Статья' });
      const row = db.prepare(`
        SELECT s."ID_статьи" as id, s."Название" as title, s."ID_работы" as rabotaId, r."Название" as rabotaName,
               v."Название" as vidName, s."Ключевые_слова" as keywords, s."Дата_публикации" as publishDate,
               s."ID_автора" as authorId, a."ФИО" as authorName, s."Текст_статьи" as content,
               s."Файл" as filePath, s."Оригинальное_имя" as originalName, s."updated_at" as updatedAt
        FROM "Статья" s
        LEFT JOIN "Работа" r ON s."ID_работы" = r."ID_работы"
        LEFT JOIN "Виды_работ" v ON r."ID_вида" = v."ID_вида"
        LEFT JOIN "Сотрудник" a ON s."ID_автора" = a."ID_сотрудника"
        WHERE s."ID_статьи" = ?
      `).get(id);

      if (!row) throw notFound('Статья не найдена');

      ok(res, { data: { ...row, file: articleFileUrl(row.id, Boolean(row.filePath)) } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/articles', upload.single('pdfFile'), asyncHandler(async (req, res) => {
    assertManageContent(req.user);

    const title = text(req.body.title, { field: 'Название', required: true, max: 300 });
    const rabotaId = parseId(req.body.rabotaId, { field: 'Работа' });
    const keywords = text(req.body.keywords, { field: 'Ключевые слова', max: 500 });
    const content = text(req.body.content, { field: 'Текст статьи', required: true, max: 100000 });
    const meta = fileMeta(req.file);

    try {
      if (!db.prepare('SELECT 1 FROM "Работа" WHERE "ID_работы" = ?').get(rabotaId)) throw badRequest('Работа не найдена');

      const result = db.prepare(`
        INSERT INTO "Статья" (
          "Название", "ID_работы", "Ключевые_слова", "Дата_публикации", "ID_автора",
          "Текст_статьи", "Файл", "Оригинальное_имя", "Размер", "MIME", "updated_at"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `).run(
        title, rabotaId, keywords, todayIso(), req.user.id, content,
        meta ? meta.storedPath : null,
        meta ? meta.originalName : null,
        meta ? meta.size : null,
        meta ? meta.mime : null
      );

      indexArticle(db, result.lastInsertRowid);

      writeAudit(db, { user: req.user, action: 'Создание статьи', entity: 'article', entityId: result.lastInsertRowid, result: 'success', ip: req.ip });

      ok(res, { data: { id: result.lastInsertRowid, title, publishDate: todayIso() } });
    } catch (error) {
      if (meta) removeStoredQuietly(meta.storedPath);
      throw error;
    }
  }));

  router.put('/articles/:id', upload.single('pdfFile'), asyncHandler(async (req, res) => {
    assertManageContent(req.user);

    const id = parseId(req.params.id, { field: 'Статья' });
    const title = text(req.body.title, { field: 'Название', required: true, max: 300 });
    const rabotaId = parseId(req.body.rabotaId, { field: 'Работа' });
    const keywords = text(req.body.keywords, { field: 'Ключевые слова', max: 500 });
    const content = text(req.body.content, { field: 'Текст статьи', required: true, max: 100000 });
    const meta = fileMeta(req.file);

    try {
      const existing = db.prepare('SELECT "Файл" as file FROM "Статья" WHERE "ID_статьи" = ?').get(id);
      if (!existing) throw notFound('Статья не найдена');
      if (!db.prepare('SELECT 1 FROM "Работа" WHERE "ID_работы" = ?').get(rabotaId)) throw badRequest('Работа не найдена');

      db.prepare(`
        UPDATE "Статья"
        SET "Название" = ?, "ID_работы" = ?, "Ключевые_слова" = ?, "Текст_статьи" = ?,
            "Файл" = ?, "Оригинальное_имя" = ?, "Размер" = ?, "MIME" = ?,
            "updated_at" = datetime('now', 'localtime')
        WHERE "ID_статьи" = ?
      `).run(
        title, rabotaId, keywords, content,
        meta ? meta.storedPath : existing.file,
        meta ? meta.originalName : null,
        meta ? meta.size : null,
        meta ? meta.mime : null,
        id
      );

      if (meta && existing.file && existing.file !== meta.storedPath) {
        removeStoredQuietly(existing.file);
      }

      indexArticle(db, id);

      writeAudit(db, { user: req.user, action: 'Изменение статьи', entity: 'article', entityId: id, result: 'success', ip: req.ip });

      ok(res, { data: { id } });
    } catch (error) {
      if (meta) removeStoredQuietly(meta.storedPath);
      throw error;
    }
  }));

  // Удаление статьи: только администратор — так же, как в интерфейсе.
  router.delete('/articles/:id', (req, res, next) => {
    try {
      assertAdmin(req.user);
      const id = parseId(req.params.id, { field: 'Статья' });

      const existing = db.prepare('SELECT "Файл" as file FROM "Статья" WHERE "ID_статьи" = ?').get(id);
      if (!existing) throw notFound('Статья не найдена');

      db.prepare('DELETE FROM "Статья" WHERE "ID_статьи" = ?').run(id);
      if (existing.file) removeStoredQuietly(existing.file);
      removeIndex(db, 'article', id);

      writeAudit(db, { user: req.user, action: 'Удаление статьи', entity: 'article', entityId: id, result: 'success', ip: req.ip });

      ok(res, {});
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createCatalogRouter;
