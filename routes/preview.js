import express from 'express';
import { badRequest, notFound } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';
import { assertObjectAccess } from '../lib/permissions.js';
import { id as parseId } from '../lib/validate.js';
import { buildContent, previewMeta, readStoredBuffer } from '../lib/preview.js';
import { convertToPdf, findLibreOffice } from '../lib/office/convert.js';
import { writeAudit } from '../lib/audit.js';

function loadDocument(db, id) {
  const row = db.prepare(`
    SELECT "ID_документа" as id, "Название" as title, "Файл" as file,
           "Оригинальное_имя" as originalName, "MIME" as mime, "Размер" as size,
           "Версия" as version, "ID_объекта" as objectId
    FROM "Документ_ПТО" WHERE "ID_документа" = ?
  `).get(id);

  if (!row) throw notFound();
  return row;
}

function loadRevision(db, id) {
  const row = db.prepare(`
    SELECT r."ID_редакции" as id, r."ID_документа" as documentId, r."Версия" as version,
           r."Файл" as file, r."Оригинальное_имя" as originalName, r."MIME" as mime,
           r."Размер" as size, d."ID_объекта" as objectId, d."Версия" as actualVersion
    FROM "Редакция_ПТО" r
    JOIN "Документ_ПТО" d ON r."ID_документа" = d."ID_документа"
    WHERE r."ID_редакции" = ?
  `).get(id);

  if (!row) throw notFound();
  return row;
}

function loadRemarkAttachment(db, id) {
  const row = db.prepare(`
    SELECT a."ID_вложения" as id, a."ID_замечания" as remarkId, a."Файл" as file,
           a."Оригинальное_имя" as originalName, a."MIME" as mime, a."Размер" as size,
           z."ID_объекта" as objectId
    FROM "Вложение_замечания" a
    JOIN "Замечание" z ON a."ID_замечания" = z."ID_замечания"
    WHERE a."ID_вложения" = ?
  `).get(id);

  if (!row) throw notFound();
  return row;
}

function streamConvertedPdf(res, record) {
  const office = findLibreOffice();
  if (!office.available) {
    throw badRequest('Предпросмотр этого формата недоступен: на сервере не установлен LibreOffice');
  }

  const { absolute } = readStoredBuffer(record.file, { maxBytes: 60 * 1024 * 1024 });
  const pdf = convertToPdf(absolute);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(pdf);
}

export function createPreviewRouter({ db }) {
  const router = express.Router();

  const audit = (req, action, record, result = 'success') => writeAudit(db, {
    user: req.user,
    action,
    entity: 'preview',
    entityId: record.id,
    objectId: record.objectId,
    result,
    ip: req.ip
  });

  // --- Документ ПТО ---

  router.get('/preview/document/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Документ' });
      const record = loadDocument(db, id);
      assertObjectAccess(db, req.user, record.objectId);

      if (!record.file) throw notFound('К документу не приложен файл');

      const meta = previewMeta({
        storedPath: record.file,
        originalName: record.originalName,
        mime: record.mime,
        size: record.size,
        inlineUrl: `/api/files/document/${id}?disposition=inline`,
        downloadUrl: `/api/files/document/${id}?disposition=attachment`,
        extra: {
          documentId: id,
          title: record.title,
          version: record.version,
          isCurrent: true,
          pdfUrl: `/api/preview/document/${id}/pdf`
        }
      });

      ok(res, { data: meta });
    } catch (error) {
      next(error);
    }
  });

  router.get('/preview/document/:id/content', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Документ' });
      const record = loadDocument(db, id);
      assertObjectAccess(db, req.user, record.objectId);
      if (!record.file) throw notFound('К документу не приложен файл');

      const content = buildContent(record.file, record.originalName || record.file);
      audit(req, 'Просмотр документа', record);
      ok(res, { data: content });
    } catch (error) {
      next(error);
    }
  });

  router.get('/preview/document/:id/pdf', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Документ' });
      const record = loadDocument(db, id);
      assertObjectAccess(db, req.user, record.objectId);
      if (!record.file) throw notFound('К документу не приложен файл');

      audit(req, 'Просмотр документа (конвертация)', record);
      streamConvertedPdf(res, record);
    } catch (error) {
      next(error);
    }
  });

  // --- Редакция документа ---

  router.get('/preview/revision/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Редакция' });
      const record = loadRevision(db, id);
      assertObjectAccess(db, req.user, record.objectId);

      if (!record.file) throw badRequest('У этой редакции нет файла');

      const meta = previewMeta({
        storedPath: record.file,
        originalName: record.originalName,
        mime: record.mime,
        size: record.size,
        inlineUrl: `/api/files/revision/${id}?disposition=inline`,
        downloadUrl: `/api/files/revision/${id}?disposition=attachment`,
        extra: {
          documentId: record.documentId,
          revisionId: id,
          version: record.version,
          isCurrent: Number(record.version) === Number(record.actualVersion),
          pdfUrl: `/api/preview/revision/${id}/pdf`
        }
      });

      ok(res, { data: meta });
    } catch (error) {
      next(error);
    }
  });

  router.get('/preview/revision/:id/content', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Редакция' });
      const record = loadRevision(db, id);
      assertObjectAccess(db, req.user, record.objectId);
      if (!record.file) throw badRequest('У этой редакции нет файла');

      const content = buildContent(record.file, record.originalName || record.file);
      audit(req, 'Просмотр редакции', record);
      ok(res, { data: content });
    } catch (error) {
      next(error);
    }
  });

  router.get('/preview/revision/:id/pdf', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Редакция' });
      const record = loadRevision(db, id);
      assertObjectAccess(db, req.user, record.objectId);
      if (!record.file) throw badRequest('У этой редакции нет файла');

      audit(req, 'Просмотр редакции (конвертация)', record);
      streamConvertedPdf(res, record);
    } catch (error) {
      next(error);
    }
  });

  // --- Вложение замечания ---

  router.get('/preview/remark/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Вложение' });
      const record = loadRemarkAttachment(db, id);
      assertObjectAccess(db, req.user, record.objectId);

      const meta = previewMeta({
        storedPath: record.file,
        originalName: record.originalName,
        mime: record.mime,
        size: record.size,
        inlineUrl: `/api/files/remark/${id}?disposition=inline`,
        downloadUrl: `/api/files/remark/${id}?disposition=attachment`,
        extra: { remarkId: record.remarkId, isCurrent: true }
      });

      ok(res, { data: meta });
    } catch (error) {
      next(error);
    }
  });

  router.get('/preview/remark/:id/content', (req, res, next) => {
    try {
      const id = parseId(req.params.id, { field: 'Вложение' });
      const record = loadRemarkAttachment(db, id);
      assertObjectAccess(db, req.user, record.objectId);

      const content = buildContent(record.file, record.originalName || record.file);
      audit(req, 'Просмотр вложения замечания', record);
      ok(res, { data: content });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createPreviewRouter;
