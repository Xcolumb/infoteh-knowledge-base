import fs from 'fs';
import express from 'express';
import { asyncHandler, badRequest } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';
import { assertManagePto, canAccessObject } from '../lib/permissions.js';
import { PTO_STATUSES, PTO_TYPES } from '../lib/constants.js';
import { parseCsv, toObjects } from '../lib/csv.js';
import { upload, fileMeta, removeStoredQuietly, resolveStoredPath } from '../lib/files.js';
import { ensureDocumentText, indexDocument } from '../lib/search.js';
import { writeAudit } from '../lib/audit.js';

const TYPE_ALIASES = {
  'ид': 'Исполнительная документация',
  'исполнительная документация': 'Исполнительная документация',
  'ппр': 'ППР',
  'аоср': 'Акт скрытых работ',
  'акт скрытых работ': 'Акт скрытых работ',
  'жр': 'Журнал работ',
  'журнал работ': 'Журнал работ',
  'вк': 'Входной контроль',
  'входной контроль': 'Входной контроль'
};

const HEADER_ALIASES = {
  'тип': 'type',
  'тип документа': 'type',
  'наименование': 'title',
  'название': 'title',
  'объект': 'object',
  'шифр': 'cipher',
  'раздел': 'projectSection',
  'раздел проекта': 'projectSection',
  'статус': 'status',
  'срок': 'dueDate',
  'ответственный': 'responsible',
  'описание': 'description'
};

function normalizeRow(row) {
  const typeRaw = String(row.type || '').trim().toLowerCase();
  const type = TYPE_ALIASES[typeRaw] || row.type || '';
  const statusRaw = String(row.status || '').trim();
  const status = PTO_STATUSES.includes(statusRaw) ? statusRaw : 'Черновик';

  return {
    type: PTO_TYPES.includes(type) ? type : String(row.type || '').trim(),
    title: String(row.title || '').trim(),
    object: String(row.object || '').trim(),
    cipher: String(row.cipher || '').trim(),
    projectSection: String(row.projectSection || '').trim(),
    status,
    dueDate: String(row.dueDate || '').trim(),
    responsible: String(row.responsible || '').trim(),
    description: String(row.description || '').trim()
  };
}

function validateRows(db, rows, user) {
  const objects = new Map(db.prepare('SELECT "ID_объекта" as id, "Название" as name FROM "Объект"').all().map((row) => [row.name.trim().toLowerCase(), row]));

  return rows.map((row, index) => {
    const errors = [];
    const normalized = normalizeRow(row);
    let objectId = null;

    if (!normalized.title) errors.push('не указано наименование');

    if (!PTO_TYPES.includes(normalized.type)) {
      errors.push(`неизвестный тип «${row.type || ''}»`);
    }

    if (normalized.object) {
      const object = objects.get(normalized.object.toLowerCase());

      if (!object) {
        errors.push(`объект не найден: «${normalized.object}»`);
      } else if (!canAccessObject(db, user, object.id)) {
        errors.push(`нет доступа к объекту «${normalized.object}»`);
      } else {
        objectId = object.id;
      }
    }

    if (normalized.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(normalized.dueDate)) {
      errors.push('срок должен быть в формате ГГГГ-ММ-ДД');
    }

    if (normalized.status && !PTO_STATUSES.includes(normalized.status)) {
      errors.push(`неизвестный статус «${normalized.status}»`);
    }

    const duplicate = Boolean(db.prepare(`
      SELECT 1 FROM "Документ_ПТО"
      WHERE lower("Название") = lower(?) AND COALESCE("Шифр", '') = ? AND COALESCE("ID_объекта", 0) = ?
    `).get(normalized.title, normalized.cipher, objectId || 0));

    return {
      index: index + 1,
      data: { ...normalized, objectId },
      errors,
      duplicate
    };
  });
}

export function createImportRouter({ db }) {
  const router = express.Router();

  router.post('/import/preview', upload.single('file'), asyncHandler(async (req, res) => {
    assertManagePto(req.user);

    const meta = fileMeta(req.file);
    if (!meta) throw badRequest('Файл CSV не приложен');

    const absolute = resolveStoredPath(meta.storedPath);
    const text = fs.readFileSync(absolute, 'utf8');

    removeStoredQuietly(meta.storedPath);

    const parsed = toObjects(parseCsv(text), { headerAliases: HEADER_ALIASES });

    if (!parsed.length) throw badRequest('В файле нет строк для импорта');

    const rows = validateRows(db, parsed.slice(0, 1000), req.user);

    ok(res, {
      data: {
        rows,
        summary: {
          total: rows.length,
          valid: rows.filter((row) => row.errors.length === 0 && !row.duplicate).length,
          invalid: rows.filter((row) => row.errors.length > 0).length,
          duplicates: rows.filter((row) => row.duplicate && row.errors.length === 0).length
        }
      }
    });
  }));

  router.post('/import/commit', (req, res, next) => {
    try {
      assertManagePto(req.user);

      const incoming = Array.isArray(req.body.rows) ? req.body.rows : null;
      if (!incoming || incoming.length === 0) throw badRequest('Нет данных для импорта');
      if (incoming.length > 1000) throw badRequest('За один раз можно импортировать не более 1000 строк');

      const rows = validateRows(db, incoming, req.user);
      const invalid = rows.filter((row) => row.errors.length > 0);

      if (invalid.length) {
        return res.status(400).json({
          success: false,
          error: `Импорт отменён: ${invalid.length} строк с ошибками. Исправьте файл и повторите.`,
          code: 'IMPORT_INVALID',
          details: invalid.slice(0, 50)
        });
      }

      const usable = rows.filter((row) => !row.duplicate);

      const insert = db.prepare(`
        INSERT INTO "Документ_ПТО" (
          "Тип", "Название", "ID_объекта", "Шифр", "Раздел_проекта", "Статус", "Срок", "Ответственный",
          "Текст", "Файл", "ID_автора", "Версия", "Актуализирован", "updated_at"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, date('now', 'localtime'), datetime('now', 'localtime'))
      `);

      const history = db.prepare(`
        INSERT INTO "История_ПТО" ("ID_документа", "Дата", "Автор", "Действие", "Статус_стал", "Версия", "Комментарий")
        VALUES (?, datetime('now', 'localtime'), ?, 'Создан', ?, 1, 'Импорт из CSV')
      `);

      const run = db.transaction(() => {
        const created = [];
        for (const row of usable) {
          const result = insert.run(
            row.data.type, row.data.title, row.data.objectId, row.data.cipher || null,
            row.data.projectSection || null, row.data.status, row.data.dueDate || null,
            row.data.responsible || null, row.data.description || null, req.user.id
          );
          history.run(result.lastInsertRowid, req.user.fullName, row.data.status);
          created.push(result.lastInsertRowid);
        }
        return created;
      });

      const created = run();

      for (const id of created) {
        ensureDocumentText(db, id);
        indexDocument(db, id);
      }

      writeAudit(db, {
        user: req.user,
        action: 'Импорт документов ПТО',
        entity: 'import',
        result: 'success',
        ip: req.ip,
        details: { created: created.length, duplicatesSkipped: rows.length - usable.length }
      });

      ok(res, {
        created: created.length,
        skippedDuplicates: rows.length - usable.length,
        ids: created
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createImportRouter;
