import express from 'express';
import { ok } from '../lib/middleware.js';
import { objectScopeClause } from '../lib/permissions.js';
import { PTO_CLOSED_STATUSES, REMARK_CLOSED_STATUSES } from '../lib/constants.js';
import { writeAudit } from '../lib/audit.js';

function cell(value) {
  const string = String(value ?? '');
  return /[";\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

export function createReportsRouter({ db }) {
  const router = express.Router();

  // Фильтр по доступным объектам: возвращает и SQL-условие, и параметры.
  function scopeParts(user, column = 'd."ID_объекта"') {
    const scope = objectScopeClause(db, user, column);
    return {
      clause: scope.clause ? scope.clause.replace(/^\s*AND\s*/, '') : '',
      params: scope.params
    };
  }

  router.get('/reports/summary', (req, res) => {
    const objectId = Number(req.query.objectId) || null;
    const dateFrom = String(req.query.from || '').trim() || null;
    const dateTo = String(req.query.to || '').trim() || null;

    const conditions = ['1 = 1'];
    const params = [];

    if (objectId) {
      conditions.push('d."ID_объекта" = ?');
      params.push(objectId);
    }

    const scope = scopeParts(req.user);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
    }

    if (dateFrom) {
      conditions.push('date(d."updated_at") >= date(?)');
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push('date(d."updated_at") <= date(?)');
      params.push(dateTo);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const byStatus = db.prepare(`
      SELECT d."Статус" as status, COUNT(*) as count
      FROM "Документ_ПТО" d ${where}
      GROUP BY d."Статус"
    `).all(...params);

    const total = byStatus.reduce((sum, row) => sum + row.count, 0);
    const approved = byStatus.filter((row) => row.status === 'Утверждён').reduce((sum, row) => sum + row.count, 0);
    const inWork = byStatus.filter((row) => ['На проверке', 'На согласовании'].includes(row.status)).reduce((sum, row) => sum + row.count, 0);

    const overdue = db.prepare(`
      SELECT COUNT(*) as count FROM "Документ_ПТО" d
      ${where} AND d."Срок" IS NOT NULL AND d."Срок" <> ''
        AND d."Срок" < date('now', 'localtime')
        AND d."Статус" NOT IN ('Утверждён', 'В архиве')
    `).get(...params).count;

    const dueSoon = db.prepare(`
      SELECT COUNT(*) as count FROM "Документ_ПТО" d
      ${where} AND d."Срок" IS NOT NULL AND d."Срок" <> ''
        AND d."Срок" >= date('now', 'localtime')
        AND d."Срок" <= date('now', 'localtime', '+3 day')
        AND d."Статус" NOT IN ('Утверждён', 'В архиве')
    `).get(...params).count;

    const remarksOpen = db.prepare(`
      SELECT COUNT(*) as count FROM "Замечание"
      WHERE "Статус" NOT IN (${REMARK_CLOSED_STATUSES.map(() => '?').join(', ')})
        ${objectId ? 'AND "ID_объекта" = ?' : ''}
    `).get(...REMARK_CLOSED_STATUSES, ...(objectId ? [objectId] : [])).count;

    const remarksOverdue = db.prepare(`
      SELECT COUNT(*) as count FROM "Замечание"
      WHERE "Срок" IS NOT NULL AND "Срок" <> '' AND "Срок" < date('now', 'localtime')
        AND "Статус" NOT IN (${REMARK_CLOSED_STATUSES.map(() => '?').join(', ')})
        ${objectId ? 'AND "ID_объекта" = ?' : ''}
    `).get(...REMARK_CLOSED_STATUSES, ...(objectId ? [objectId] : [])).count;

    const sets = db.prepare(`
      SELECT k."ID_комплекта" as id, k."Название" as name, k."ID_объекта" as objectId
      FROM "Комплект" k ${objectId ? 'WHERE k."ID_объекта" = ?' : ''}
    `).all(...(objectId ? [objectId] : []));

    let setsComplete = 0;
    let setsIncomplete = 0;

    for (const set of sets) {
      const requirements = db.prepare('SELECT "ID_требования" as id FROM "Требование_комплекта" WHERE "ID_комплекта" = ?').all(set.id);
      if (requirements.length === 0) {
        setsIncomplete += 1;
        continue;
      }

      let allReady = true;
      for (const requirement of requirements) {
        const docs = db.prepare(`
          SELECT d."Статус" as status FROM "Документ_комплекта" s
          JOIN "Документ_ПТО" d ON s."ID_документа" = d."ID_документа"
          WHERE s."ID_требования" = ?
        `).all(requirement.id);

        if (!docs.some((doc) => PTO_CLOSED_STATUSES.includes(doc.status))) {
          allReady = false;
          break;
        }
      }

      if (allReady) setsComplete += 1;
      else setsIncomplete += 1;
    }

    const closedOnTime = db.prepare(`
      SELECT COUNT(*) as count FROM "Документ_ПТО" d
      ${where} AND d."Статус" = 'Утверждён' AND d."Срок" IS NOT NULL AND d."Срок" <> ''
        AND date(d."Актуализирован") <= date(d."Срок")
    `).get(...params).count;

    const approvedWithDue = db.prepare(`
      SELECT COUNT(*) as count FROM "Документ_ПТО" d
      ${where} AND d."Статус" = 'Утверждён' AND d."Срок" IS NOT NULL AND d."Срок" <> ''
    `).get(...params).count;

    ok(res, {
      data: {
        total,
        approved,
        inWork,
        overdue,
        dueSoon,
        remarksOpen,
        remarksOverdue,
        setsTotal: sets.length,
        setsComplete,
        setsIncomplete,
        byStatus,
        onTimePercent: approvedWithDue ? Math.round((closedOnTime / approvedWithDue) * 100) : null,
        filters: { objectId, dateFrom, dateTo }
      }
    });
  });

  router.get('/reports/documents.csv', (req, res) => {
    const objectId = Number(req.query.objectId) || null;
    const status = String(req.query.status || '').trim();

    const conditions = ['1 = 1'];
    const params = [];

    if (objectId) { conditions.push('d."ID_объекта" = ?'); params.push(objectId); }
    if (status && status !== 'all') { conditions.push('d."Статус" = ?'); params.push(status); }

    const scope = scopeParts(req.user);
    if (scope.clause) {
      conditions.push(scope.clause);
      params.push(...scope.params);
    }

    const rows = db.prepare(`
      SELECT d."Тип" as type, d."Название" as title, o."Название" as objectName, d."Шифр" as cipher,
             d."Раздел_проекта" as section, d."Статус" as status, d."Срок" as due, d."Ответственный" as responsible,
             d."Версия" as version, d."Актуализирован" as actualizedAt, d."updated_at" as updatedAt
      FROM "Документ_ПТО" d
      LEFT JOIN "Объект" o ON d."ID_объекта" = o."ID_объекта"
      WHERE ${conditions.join(' AND ')}
      ORDER BY d."Срок"
    `).all(...params);

    const lines = [['Тип', 'Наименование', 'Объект', 'Шифр', 'Раздел', 'Статус', 'Срок', 'Ответственный', 'Версия', 'Актуализирован', 'Обновлён'].map(cell).join(';')];
    for (const row of rows) {
      lines.push([row.type, row.title, row.objectName || '', row.cipher || '', row.section || '', row.status,
        row.due || '', row.responsible || '', row.version, row.actualizedAt || '', row.updatedAt || ''].map(cell).join(';'));
    }

    writeAudit(db, { user: req.user, action: 'Экспорт отчёта по документам', entity: 'report', result: 'success', ip: req.ip, details: { rows: rows.length } });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-documents-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  });

  router.get('/reports/remarks.csv', (req, res) => {
    const conditions = ['1 = 1'];
    const params = [];

    const scope = objectScopeClause(db, req.user, 'z."ID_объекта"');
    if (scope.clause) {
      conditions.push(scope.clause.replace(/^\s*AND\s*/, ''));
      params.push(...scope.params);
    }

    const rows = db.prepare(`
      SELECT z."Номер" as number, z."Дата" as date, o."Название" as objectName, d."Название" as documentTitle,
             z."Описание" as description, z."Ответственный" as responsible, z."Срок" as due,
             z."Статус" as status, z."Дата_закрытия" as closedAt
      FROM "Замечание" z
      LEFT JOIN "Объект" o ON z."ID_объекта" = o."ID_объекта"
      LEFT JOIN "Документ_ПТО" d ON z."ID_документа" = d."ID_документа"
      WHERE ${conditions.join(' AND ')}
      ORDER BY z."Срок"
    `).all(...params);

    const lines = [['Номер', 'Дата', 'Объект', 'Документ', 'Описание', 'Ответственный', 'Срок', 'Статус', 'Дата закрытия'].map(cell).join(';')];
    for (const row of rows) {
      lines.push([row.number || '', row.date, row.objectName || '', row.documentTitle || '', row.description,
        row.responsible || '', row.due || '', row.status, row.closedAt || ''].map(cell).join(';'));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-remarks-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  });

  return router;
}

export default createReportsRouter;
