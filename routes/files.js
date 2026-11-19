import express from 'express';
import { notFound } from '../lib/errors.js';
import { assertObjectAccess } from '../lib/permissions.js';
import { id as parseId } from '../lib/validate.js';
import { streamStoredFile } from '../lib/files.js';

export function createFilesRouter({ db }) {
  const router = express.Router();

  const dispositionOf = (req) => (String(req.query.disposition || '') === 'inline' ? 'inline' : (String(req.query.disposition || '') === 'attachment' ? 'attachment' : 'auto'));

  router.get('/files/article/:id', (req, res, next) => {
    try {
      const disposition = dispositionOf(req);
      const id = parseId(req.params.id, { field: 'Статья' });
      const row = db.prepare('SELECT "Файл" as file, "Оригинальное_имя" as originalName, "MIME" as mime FROM "Статья" WHERE "ID_статьи" = ?').get(id);
      if (!row || !row.file) throw notFound('Файл не привязан к статье');

      streamStoredFile(res, { storedPath: row.file, originalName: row.originalName, mime: row.mime, disposition });
    } catch (error) {
      next(error);
    }
  });

  router.get('/files/document/:id', (req, res, next) => {
    try {
      const disposition = dispositionOf(req);
      const id = parseId(req.params.id, { field: 'Документ' });
      const row = db.prepare(`
        SELECT d."Файл" as file, d."Оригинальное_имя" as originalName, d."MIME" as mime, d."ID_объекта" as objectId
        FROM "Документ_ПТО" d WHERE d."ID_документа" = ?
      `).get(id);

      if (!row) throw notFound('Документ не найден');
      assertObjectAccess(db, req.user, row.objectId);
      if (!row.file) throw notFound('Файл не привязан к документу');

      streamStoredFile(res, { storedPath: row.file, originalName: row.originalName, mime: row.mime, disposition });
    } catch (error) {
      next(error);
    }
  });

  router.get('/files/revision/:id', (req, res, next) => {
    try {
      const disposition = dispositionOf(req);
      const id = parseId(req.params.id, { field: 'Редакция' });
      const row = db.prepare(`
        SELECT r."Файл" as file, r."Оригинальное_имя" as originalName, r."MIME" as mime,
               d."ID_объекта" as objectId
        FROM "Редакция_ПТО" r
        JOIN "Документ_ПТО" d ON r."ID_документа" = d."ID_документа"
        WHERE r."ID_редакции" = ?
      `).get(id);

      if (!row) throw notFound('Редакция не найдена');
      assertObjectAccess(db, req.user, row.objectId);
      if (!row.file) throw notFound('У этой редакции нет файла');

      streamStoredFile(res, { storedPath: row.file, originalName: row.originalName, mime: row.mime, disposition });
    } catch (error) {
      next(error);
    }
  });

  router.get('/files/remark/:id', (req, res, next) => {
    try {
      const disposition = dispositionOf(req);
      const id = parseId(req.params.id, { field: 'Вложение' });
      const row = db.prepare(`
        SELECT a."Файл" as file, a."Оригинальное_имя" as originalName, a."MIME" as mime,
               z."ID_объекта" as objectId
        FROM "Вложение_замечания" a
        JOIN "Замечание" z ON a."ID_замечания" = z."ID_замечания"
        WHERE a."ID_вложения" = ?
      `).get(id);

      if (!row) throw notFound('Вложение не найдено');
      assertObjectAccess(db, req.user, row.objectId);

      streamStoredFile(res, { storedPath: row.file, originalName: row.originalName, mime: row.mime, disposition });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createFilesRouter;
