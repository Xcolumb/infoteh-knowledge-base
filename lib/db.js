import fs from 'fs';
import Database from 'better-sqlite3';
import config from '../config.js';
import { runMigrations } from './migrations/index.js';
import { logger } from './logger.js';

export function openDatabase({ file = config.databasePath, readonly = false } = {}) {
  const db = new Database(file, { readonly });

  if (readonly) return db;

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const result = runMigrations(db, { logger });
  if (result.appliedCount > 0) {
    logger.info('Миграции применены', result);
  }

  return db;
}

export function hasFts5(db) {
  if (db.__ftsUnavailable) return false;
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'Поиск'").get();
  return Boolean(row);
}

export function ensureUploadsDir() {
  if (!fs.existsSync(config.uploadsPath)) {
    fs.mkdirSync(config.uploadsPath, { recursive: true });
  }
  return config.uploadsPath;
}

export default openDatabase;
