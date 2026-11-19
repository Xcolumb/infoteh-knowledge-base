import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import config from '../config.js';
import { ensureUploadsDir } from './db.js';
import { badRequest, notFound } from './errors.js';
import { MIME_BY_EXTENSION, ALLOWED_UPLOAD_EXTENSIONS } from './constants.js';
import { safeOriginalName, uploadExtension } from './validate.js';
import { logger } from './logger.js';

const BLOCKED_MIME = new Set(['text/html', 'application/xhtml+xml', 'application/x-msdownload', 'application/x-sh', 'text/x-sh']);

function fileFilter(req, file, callback) {
  const extension = uploadExtension(safeOriginalName(file.originalname || file.filename || ''));

  if (!extension || !ALLOWED_UPLOAD_EXTENSIONS.includes(extension)) {
    return callback(badRequest(`Недопустимый тип файла. Разрешены: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`));
  }

  if (file.mimetype && BLOCKED_MIME.has(String(file.mimetype).toLowerCase())) {
    return callback(badRequest('Недопустимый тип содержимого файла'));
  }

  callback(null, true);
}

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, ensureUploadsDir()),
  filename: (req, file, callback) => {
    const extension = uploadExtension(safeOriginalName(file.originalname || '')) || '';
    callback(null, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${extension}`);
  }
});

export const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter
});

export function fileMeta(file) {
  if (!file) return null;

  const originalName = safeOriginalName(file.originalname);
  const extension = uploadExtension(originalName) || '';

  return {
    storedPath: `uploads/${file.filename}`,
    originalName,
    size: file.size,
    mime: MIME_BY_EXTENSION[extension] || file.mimetype || 'application/octet-stream'
  };
}

// Приводит сохранённый в БД путь к абсолютному пути внутри папки uploads.
// Любая попытка выйти за пределы каталога (path traversal) отклоняется.
export function resolveStoredPath(storedPath) {
  if (!storedPath) throw notFound('Файл не привязан к записи');

  const normalized = String(storedPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const relative = normalized.startsWith('uploads/') ? normalized.slice('uploads/'.length) : normalized;
  const baseName = path.basename(relative);

  if (!baseName || baseName === '.' || baseName === '..') {
    throw notFound('Некорректный путь к файлу');
  }

  const extension = uploadExtension(baseName);
  if (!extension || !ALLOWED_UPLOAD_EXTENSIONS.includes(extension)) {
    throw notFound('Недопустимый тип файла');
  }

  const absolute = path.resolve(config.uploadsPath, baseName);
  const root = path.resolve(config.uploadsPath);

  if (absolute !== path.join(root, baseName) || !absolute.startsWith(root + path.sep)) {
    throw notFound('Некорректный путь к файлу');
  }

  return absolute;
}

// RFC 5987: ASCII-подстановка + filename* с UTF-8 для кириллических имён.
function contentDisposition(originalName, mime, disposition = 'auto') {
  const name = safeOriginalName(originalName || 'file');
  const asciiFallback = name
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 120) || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());

  const isPreviewable = String(mime || '').startsWith('application/pdf') || String(mime || '').startsWith('image/');
  const inline = disposition === 'inline' ? isPreviewable : (disposition === 'auto' ? isPreviewable : false);

  return `${inline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function streamStoredFile(res, { storedPath, originalName, mime, cache = 'private, no-store', disposition = 'auto' }) {
  const absolute = resolveStoredPath(storedPath);

  if (!fs.existsSync(absolute)) {
    throw notFound('Файл не найден на диске');
  }

  const stats = fs.statSync(absolute);
  const contentType = mime || MIME_BY_EXTENSION[uploadExtension(absolute)] || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', stats.size);
  res.setHeader('Content-Disposition', contentDisposition(originalName, contentType, disposition));
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  fs.createReadStream(absolute).pipe(res);
}

export function removeStoredQuietly(storedPath) {
  if (!storedPath) return;
  try {
    const absolute = resolveStoredPath(storedPath);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch (error) {
    logger.warn('Не удалось удалить файл', { error: error.message });
  }
}

export default {
  upload,
  fileMeta,
  resolveStoredPath,
  streamStoredFile,
  removeStoredQuietly
};
