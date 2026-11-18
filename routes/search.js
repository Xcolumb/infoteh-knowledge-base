import express from 'express';
import { ok } from '../lib/middleware.js';
import { searchAll, ftsAvailable } from '../lib/search.js';
import { getAccessibleObjectIds } from '../lib/permissions.js';
import { writeAudit } from '../lib/audit.js';

export function createSearchRouter({ db }) {
  const router = express.Router();

  router.get('/search', (req, res) => {
    const query = String(req.query.q || '').trim().slice(0, 200);
    const limit = Math.min(Number(req.query.limit) || 30, 100);

    const accessibleObjectIds = getAccessibleObjectIds(db, req.user);
    const { engine, results } = searchAll(db, { query, accessibleObjectIds, limit });

    if (query.length >= 2) {
      writeAudit(db, {
        user: req.user,
        action: 'Поиск',
        entity: 'search',
        result: 'success',
        ip: req.ip,
        details: { query: query.slice(0, 100), engine, found: results.length }
      });
    }

    ok(res, {
      engine,
      query,
      data: results.map((row) => ({
        kind: row.kind,
        id: Number(row.id),
        title: row.title,
        fragment: row.fragment,
        objectId: row.objectId === '' || row.objectId === null ? null : Number(row.objectId),
        openUrl: row.kind === 'document' ? `/api/files/document/${row.id}` : null
      }))
    });
  });

  router.get('/search/status', (req, res) => {
    const indexed = ftsAvailable(db)
      ? db.prepare('SELECT COUNT(*) as count FROM "Поиск"').get().count
      : 0;

    ok(res, {
      engine: ftsAvailable(db) ? 'fts5' : 'like',
      indexed,
      note: ftsAvailable(db) ? null : 'FTS5 недоступен в этой сборке SQLite: используется резервный поиск по LIKE'
    });
  });

  return router;
}

export default createSearchRouter;
