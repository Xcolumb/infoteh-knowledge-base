import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import config from '../config.js';

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(absolute, base));
    } else if (entry.isFile()) {
      result.push({ absolute, relative: path.relative(base, absolute) });
    }
  }

  return result;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Полная резервная копия: снимок БД (online backup API) + файлы документов.
export async function createBackup({ label = '', keep = config.backupKeep } = {}) {
  const target = path.join(config.backupPath, `backup-${stamp()}${label ? '-' + label : ''}`);
  fs.mkdirSync(target, { recursive: true });

  const dbFile = path.join(target, 'infoteh.db');
  const source = new Database(config.databasePath, { readonly: false, fileMustExist: true });

  try {
    await source.backup(dbFile);
  } finally {
    source.close();
  }

  const uploadsTarget = path.join(target, 'uploads');
  fs.mkdirSync(uploadsTarget, { recursive: true });
  if (fs.existsSync(config.uploadsPath)) {
    fs.cpSync(config.uploadsPath, uploadsTarget, { recursive: true });
  }

  const checkDb = new Database(dbFile, { readonly: true });
  const integrity = checkDb.pragma('integrity_check', { simple: true });
  const counts = {};
  for (const table of ['Сотрудник', 'Статья', 'Объект', 'Документ_ПТО', 'История_ПТО', 'Редакция_ПТО', 'Замечание', 'Комплект']) {
    try {
      counts[table] = checkDb.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get().c;
    } catch {
      counts[table] = null;
    }
  }
  checkDb.close();

  const files = walk(uploadsTarget).map((entry) => ({
    path: entry.relative.replace(/\\/g, '/'),
    size: fs.statSync(entry.absolute).size,
    sha256: sha256(entry.absolute)
  }));

  const manifest = {
    createdAt: new Date().toISOString(),
    label,
    database: { file: 'infoteh.db', size: fs.statSync(dbFile).size, sha256: sha256(dbFile), integrity, counts },
    uploads: { files, count: files.length, totalSize: files.reduce((sum, file) => sum + file.size, 0) }
  };

  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const removed = pruneBackups(keep);

  return { target, manifest, removed };
}

export function listBackups() {
  if (!fs.existsSync(config.backupPath)) return [];

  return fs.readdirSync(config.backupPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => ({ name: entry.name, path: path.join(config.backupPath, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function pruneBackups(keep) {
  const backups = listBackups();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  const removed = [];

  for (const backup of excess) {
    fs.rmSync(backup.path, { recursive: true, force: true });
    removed.push(backup.name);
  }

  return removed;
}

export function verifyBackup(dir) {
  const problems = [];
  const manifestPath = path.join(dir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: ['нет manifest.json'] };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dbFile = path.join(dir, manifest.database.file);

  if (!fs.existsSync(dbFile)) problems.push('нет файла БД');

  if (fs.existsSync(dbFile)) {
    if (sha256(dbFile) !== manifest.database.sha256) problems.push('контрольная сумма БД не совпадает');

    const db = new Database(dbFile, { readonly: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    db.close();
  }

  for (const file of manifest.uploads.files) {
    const absolute = path.join(dir, 'uploads', file.path);
    if (!fs.existsSync(absolute)) {
      problems.push(`нет файла ${file.path}`);
      continue;
    }
    if (sha256(absolute) !== file.sha256) problems.push(`контрольная сумма ${file.path} не совпадает`);
  }

  return { ok: problems.length === 0, problems, manifest };
}

// Восстановление: сначала проверяет копию, затем делает страховочную копию
// текущего состояния и только после этого заменяет БД и файлы.
export async function restoreBackup(dir, { force = false } = {}) {
  const verification = verifyBackup(dir);
  if (!verification.ok) {
    throw new Error(`Резервная копия повреждена: ${verification.problems.join('; ')}`);
  }

  if (!force) {
    throw new Error('Восстановление перезаписывает рабочие данные. Повторите с флагом --force.');
  }

  // Страховочная копия текущего состояния — только если рабочая БД уже существует.
  let safety = null;
  if (fs.existsSync(config.databasePath)) {
    safety = (await createBackup({ label: 'pre-restore' })).target;
  }

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  for (const suffix of ['-wal', '-shm']) {
    const file = config.databasePath + suffix;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  fs.copyFileSync(path.join(dir, 'infoteh.db'), config.databasePath);

  fs.mkdirSync(config.uploadsPath, { recursive: true });
  if (fs.existsSync(path.join(dir, 'uploads'))) {
    fs.cpSync(path.join(dir, 'uploads'), config.uploadsPath, { recursive: true });
  }

  return { restored: true, safety, manifest: verification.manifest };
}

export default { createBackup, verifyBackup, restoreBackup, listBackups };
