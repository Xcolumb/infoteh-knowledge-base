import fs from 'fs';
import { resolveStoredPath } from './files.js';
import { uploadExtension } from './validate.js';
import { docxToHtml } from './office/docx-html.js';
import { xlsxToSheets } from './office/xlsx-json.js';
import { parseCsv } from './csv.js';
import { findLibreOffice } from './office/convert.js';
import { notFound, badRequest } from './errors.js';

const PDF_MAX_BYTES = 60 * 1024 * 1024;
const TEXT_MAX_BYTES = 1024 * 1024;

export const PREVIEW_KINDS = {
  PDF: 'pdf',
  IMAGE: 'image',
  DOCX: 'docx',
  XLSX: 'xlsx',
  TEXT: 'text',
  CSV: 'csv',
  DOC_LEGACY: 'doc-legacy',
  XLS_LEGACY: 'xls-legacy',
  UNSUPPORTED: 'unsupported'
};

export function detectKind(extension) {
  switch (String(extension || '').toLowerCase()) {
    case '.pdf': return PREVIEW_KINDS.PDF;
    case '.jpg':
    case '.jpeg':
    case '.png': return PREVIEW_KINDS.IMAGE;
    case '.docx': return PREVIEW_KINDS.DOCX;
    case '.xlsx': return PREVIEW_KINDS.XLSX;
    case '.txt':
    case '.md': return PREVIEW_KINDS.TEXT;
    case '.csv': return PREVIEW_KINDS.CSV;
    case '.doc': return PREVIEW_KINDS.DOC_LEGACY;
    case '.xls': return PREVIEW_KINDS.XLS_LEGACY;
    default: return PREVIEW_KINDS.UNSUPPORTED;
  }
}

export function previewMeta({ storedPath, originalName, mime, size, inlineUrl, downloadUrl, extra = {} }) {
  const extension = uploadExtension(originalName || storedPath);
  const kind = detectKind(extension);
  const office = findLibreOffice();

  const mode = (() => {
    switch (kind) {
      case PREVIEW_KINDS.PDF:
      case PREVIEW_KINDS.IMAGE:
        return 'iframe';
      case PREVIEW_KINDS.DOCX:
        return 'html';
      case PREVIEW_KINDS.XLSX:
        return 'table';
      case PREVIEW_KINDS.TEXT:
        return 'text';
      case PREVIEW_KINDS.CSV:
        return 'table';
      case PREVIEW_KINDS.DOC_LEGACY:
      case PREVIEW_KINDS.XLS_LEGACY:
        return office.available ? 'converted' : 'unsupported';
      default:
        return 'unsupported';
    }
  })();

  const notes = [];
  if (mode === 'unsupported') {
    notes.push('Предварительный просмотр этого формата недоступен. Скачайте файл для открытия в соответствующей программе.');
    if (kind === PREVIEW_KINDS.DOC_LEGACY || kind === PREVIEW_KINDS.XLS_LEGACY) {
      notes.push('Для встроенного просмотра старых форматов DOC/XLS на сервере должен быть установлен LibreOffice.');
    }
  }

  return {
    kind,
    mode,
    name: originalName || String(storedPath || '').split('/').pop(),
    mime: mime || null,
    size: size || null,
    extension,
    inlineUrl: mode === 'iframe' || mode === 'converted' ? inlineUrl : undefined,
    downloadUrl,
    notes,
    ...extra
  };
}

export function readStoredBuffer(storedPath, { maxBytes = PDF_MAX_BYTES } = {}) {
  const absolute = resolveStoredPath(storedPath);
  if (!fs.existsSync(absolute)) throw notFound('Файл не найден на диске');

  const stats = fs.statSync(absolute);
  if (stats.size > maxBytes) {
    throw badRequest('Файл слишком большой для предварительного просмотра. Скачайте его для открытия.', { size: stats.size });
  }

  return { absolute, buffer: fs.readFileSync(absolute), size: stats.size };
}

export function buildContent(storedPath, originalName) {
  const extension = uploadExtension(originalName || storedPath);
  const kind = detectKind(extension);
  const { buffer } = readStoredBuffer(storedPath, { maxBytes: kind === PREVIEW_KINDS.DOCX || kind === PREVIEW_KINDS.XLSX ? PDF_MAX_BYTES : TEXT_MAX_BYTES });

  switch (kind) {
    case PREVIEW_KINDS.DOCX:
      return { kind, ...docxToHtml(buffer) };
    case PREVIEW_KINDS.XLSX:
      return { kind, ...xlsxToSheets(buffer) };
    case PREVIEW_KINDS.CSV: {
      const text = buffer.toString('utf8');
      const rows = parseCsv(text).slice(0, 500).map((row) => row.slice(0, 40));
      return { kind, rows, truncated: rows.length >= 500, totalRows: rows.length };
    }
    case PREVIEW_KINDS.TEXT: {
      const text = buffer.toString('utf8');
      const truncated = text.length > 200_000;
      return { kind, text: truncated ? text.slice(0, 200_000) : text, truncated };
    }
    default:
      throw badRequest('Для этого формата содержимое не может быть показано как текст');
  }
}

export default { detectKind, previewMeta, buildContent, readStoredBuffer, PREVIEW_KINDS };
