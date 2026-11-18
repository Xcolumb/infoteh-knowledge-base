import fs from 'fs';
import { resolveStoredPath } from './files.js';
import { hasFts5 } from './db.js';
import { extractText } from './text-extract.js';
import { uploadExtension } from './validate.js';
import { logger } from './logger.js';

export function ftsAvailable(db) {
  return hasFts5(db);
}

function indexUpsert(db, { kind, id, objectId, title, extra, text }) {
  if (!ftsAvailable(db)) return;

  db.prepare('DELETE FROM "Поиск" WHERE "Тип" = ? AND "ID" = ?').run(kind, String(id));
  db.prepare('INSERT INTO "Поиск" ("Тип", "ID", "ID_объекта", "Заголовок", "Дополнительно", "Текст") VALUES (?, ?, ?, ?, ?, ?)')
    .run(kind, String(id), objectId === null || objectId === undefined ? '' : String(objectId), title || '', extra || '', text || '');
}

export function indexArticle(db, articleId) {
  const row = db.prepare(`
    SELECT s."ID_статьи" as id, s."Название" as title, s."Ключевые_слова" as keywords,
           s."Текст_статьи" as content, r."Название" as work, v."Название" as kind
    FROM "Статья" s
    LEFT JOIN "Работа" r ON s."ID_работы" = r."ID_работы"
    LEFT JOIN "Виды_работ" v ON r."ID_вида" = v."ID_вида"
    WHERE s."ID_статьи" = ?
  `).get(articleId);

  if (!row) return removeIndex(db, 'article', articleId);

  indexUpsert(db, {
    kind: 'article',
    id: row.id,
    objectId: null,
    title: row.title,
    extra: [row.keywords, row.work, row.kind].filter(Boolean).join(' · '),
    text: row.content || ''
  });
}

export function ensureDocumentText(db, documentId, { force = false } = {}) {
  const doc = db.prepare(`
    SELECT "ID_документа" as id, "Файл" as file, "Текст" as manualText,
           "Текст_извлечён" as extracted, "Требуется_OCR" as requiresOcr
    FROM "Документ_ПТО" WHERE "ID_документа" = ?
  `).get(documentId);

  if (!doc) return '';

  if (!force && doc.extracted) return doc.extracted;
  if (!doc.file) return doc.extracted || '';

  try {
    const absolute = resolveStoredPath(doc.file);
    if (!fs.existsSync(absolute)) return doc.extracted || '';

    const buffer = fs.readFileSync(absolute);
    const result = extractText(buffer, uploadExtension(doc.file) || '');
    const text = (result.text || '').slice(0, 200_000);

    db.prepare(`
      UPDATE "Документ_ПТО"
      SET "Текст_извлечён" = ?, "Требуется_OCR" = ?, "updated_at" = "updated_at"
      WHERE "ID_документа" = ?
    `).run(text || null, result.requiresOcr ? 1 : 0, documentId);

    return text;
  } catch (error) {
    logger.warn('Не удалось извлечь текст документа', { documentId, error: error.message });
    return doc.extracted || '';
  }
}

export function indexDocument(db, documentId) {
  const row = db.prepare(`
    SELECT d."ID_документа" as id, d."Название" as title, d."Шифр" as cipher,
           d."Раздел_проекта" as section, d."Ответственный" as responsible,
           d."Текст" as text, d."Текст_извлечён" as extracted, d."ID_объекта" as objectId,
           o."Название" as objectName
    FROM "Документ_ПТО" d
    LEFT JOIN "Объект" o ON d."ID_объекта" = o."ID_объекта"
    WHERE d."ID_документа" = ?
  `).get(documentId);

  if (!row) return removeIndex(db, 'document', documentId);

  indexUpsert(db, {
    kind: 'document',
    id: row.id,
    objectId: row.objectId,
    title: row.title,
    extra: [row.cipher, row.section, row.objectName, row.responsible].filter(Boolean).join(' · '),
    text: [row.text, row.extracted].filter(Boolean).join('\n\n')
  });
}

export function removeIndex(db, kind, id) {
  if (!ftsAvailable(db)) return;
  db.prepare('DELETE FROM "Поиск" WHERE "Тип" = ? AND "ID" = ?').run(kind, String(id));
}

export function rebuildSearchIndex(db, { logger: log = logger } = {}) {
  if (!ftsAvailable(db)) return { enabled: false };

  const articles = db.prepare('SELECT "ID_статьи" as id FROM "Статья"').all();
  const documents = db.prepare('SELECT "ID_документа" as id FROM "Документ_ПТО"').all();

  const rebuild = db.transaction(() => {
    db.prepare('DELETE FROM "Поиск"').run();
    for (const article of articles) indexArticle(db, article.id);
    for (const document of documents) {
      ensureDocumentText(db, document.id);
      indexDocument(db, document.id);
    }
  });

  rebuild();
  log.info('Индекс поиска перестроен', { articles: articles.length, documents: documents.length });

  return { enabled: true, articles: articles.length, documents: documents.length };
}

function buildMatchQuery(query) {
  return String(query)
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .map((token) => `"${token.replace(/[*:^()\-]/g, ' ').trim()}"*`)
    .join(' AND ');
}

export function searchAll(db, { query, accessibleObjectIds = [], limit = 50 } = {}) {
  const value = String(query || '').trim();
  if (value.length < 2) return { engine: 'none', results: [] };

  if (ftsAvailable(db)) {
    try {
      const match = buildMatchQuery(value);
      if (!match) return { engine: 'fts5', results: [] };

      const placeholders = accessibleObjectIds.map(() => '?').join(', ');
      const accessClause = accessibleObjectIds.length
        ? `AND ("Тип" = 'article' OR "ID_объекта" = '' OR "ID_объекта" IN (${placeholders}))`
        : `AND "Тип" = 'article'`;

      const rows = db.prepare(`
        SELECT "Тип" as kind, "ID" as id, "Заголовок" as title, "ID_объекта" as objectId,
               snippet("Поиск", 2, '<mark>', '</mark>', '…', 16) as fragment
        FROM "Поиск"
        WHERE "Поиск" MATCH ?
          ${accessClause}
        ORDER BY rank
        LIMIT ?
      `).all(match, ...accessibleObjectIds.map(String), limit);

      return { engine: 'fts5', results: rows };
    } catch (error) {
      logger.warn('Ошибка FTS-поиска, используется LIKE', { error: error.message });
    }
  }

  // Резервный режим: LIKE-поиск (медленнее, но работает без FTS5).
  const like = `%${value}%`;
  const articles = db.prepare(`
    SELECT 'article' as kind, "ID_статьи" as id, "Название" as title, NULL as objectId,
           substr("Текст_статьи", 1, 240) as fragment
    FROM "Статья"
    WHERE "Название" LIKE ? OR "Текст_статьи" LIKE ? OR COALESCE("Ключевые_слова", '') LIKE ?
    LIMIT ?
  `).all(like, like, like, limit);

  const placeholders = accessibleObjectIds.map(() => '?').join(', ');
  const accessClause = accessibleObjectIds.length
    ? `AND (d."ID_объекта" IS NULL OR d."ID_объекта" IN (${placeholders}))`
    : 'AND 1 = 0';

  const documents = db.prepare(`
    SELECT 'document' as kind, d."ID_документа" as id, d."Название" as title, d."ID_объекта" as objectId,
           substr(COALESCE(d."Текст_извлечён", d."Текст", ''), 1, 240) as fragment
    FROM "Документ_ПТО" d
    WHERE (d."Название" LIKE ? OR COALESCE(d."Шифр", '') LIKE ? OR COALESCE(d."Текст_извлечён", '') LIKE ?)
      ${accessClause}
    LIMIT ?
  `).all(like, like, like, ...accessibleObjectIds, limit);

  return { engine: 'like', results: [...articles, ...documents].slice(0, limit) };
}

export default { searchAll, rebuildSearchIndex, indexArticle, indexDocument, ensureDocumentText, removeIndex, ftsAvailable };
