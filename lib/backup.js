import os from 'node:os';
import { referencedFiles } from './file-transaction.js';
import { lockInstallation, recoverRestore, installSnapshot } from './restore-install.js';
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
    if (entry.isSymbolicLink()) throw Error('Символическая ссылка в хранилище');
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
export async function createBackup(options = {}) {
  const lock = lockInstallation(false);
  try {
    if (fs.existsSync(config.databasePath+'.restore-journal')) throw Error('Сначала завершите восстановление');
    return await createSnapshot(options);
  } finally { lock.close(); }
}

async function createSnapshot({ label = '', keep = config.backupKeep } = {}) {
  if (!/^[\p{L}\p{N}_-]{0,80}$/u.test(label)) throw Error('Недопустимая метка копии');
  const final = path.join(config.backupPath, `backup-${stamp()}${label ? '-' + label : ''}`);
  const target = final+'.'+crypto.randomUUID()+'.partial';
  fs.mkdirSync(target, { recursive: true });
  try {

  const dbFile = path.join(target, 'infoteh.db');
  const source = new Database(config.databasePath, { readonly: false, fileMustExist: true });

  const guard = new Database(config.databasePath);
  const uploadsTarget = path.join(target, 'uploads');
  try {
    guard.exec('BEGIN IMMEDIATE');
    await source.backup(dbFile);

  fs.mkdirSync(uploadsTarget, { recursive: true });
  if (fs.existsSync(config.uploadsPath)) {
    fs.cpSync(config.uploadsPath, uploadsTarget, { recursive: true, filter: p => p !== path.join(config.uploadsPath,'.pending-files') && !(path.dirname(p)===path.join(config.uploadsPath,'company-photos') && p.endsWith('.tmp')) });
  }

  } finally { guard.close(); source.close(); }

  const checkDb = new Database(dbFile);
  checkDb.pragma('journal_mode = DELETE');
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

  const check = verifyBackup(target);
  if (!check.ok) throw Error(check.problems.join('; '));
  fs.renameSync(target,final);
  const removed = pruneBackups(keep);

  return { target:final, manifest, removed };
  } finally { fs.rmSync(target,{recursive:true,force:true}); }
}

export function listBackups() {
  if (!fs.existsSync(config.backupPath)) return [];

  return fs.readdirSync(config.backupPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-') && !entry.name.endsWith('.partial'))
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

function verifySnapshot(dir) {
  const problems = [];
  const allowed = ['manifest.json','infoteh.db','uploads','infoteh.db-shm','infoteh.db-wal'];
  if (fs.readdirSync(dir).some(name=>!allowed.includes(name))) throw Error('Посторонние файлы в корне копии');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  if (manifest.database.file !== 'infoteh.db') throw Error('Некорректное имя файла БД');
  const dbFile = path.join(dir,'infoteh.db');
  const root = path.join(dir,'uploads');
  for (const p of [dir,dbFile,root,path.join(dir,'manifest.json')]) if(fs.lstatSync(p).isSymbolicLink()) throw Error('Символическая ссылка в копии');
  const actual = new Map(walk(root).map(f => [f.relative.replaceAll(path.sep,'/'),f.absolute]));
  const expected = new Set();
  for (const f of manifest.uploads.files) {
    if (!actual.has(f.path) || expected.has(f.path)) { problems.push('Неверная запись манифеста: '+f.path); continue; }
    expected.add(f.path);
    const disk = actual.get(f.path);
    if (fs.statSync(disk).size !== f.size || sha256(disk)!==f.sha256) problems.push('контрольная сумма файла не совпадает: '+f.path);
  }
  if (actual.size!==expected.size) problems.push('Лишние файлы в копии');
  if (sha256(dbFile)!==manifest.database.sha256) problems.push('контрольная сумма БД не совпадает');
  // Старые манифесты описывают только основной файл БД, отдельно от WAL.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'pto-verify-'));
  let db;
  try {
    const standalone = path.join(temporary,'snapshot.db');
    fs.copyFileSync(dbFile,standalone);
    db = new Database(standalone,{readonly:true});
    if(db.pragma('integrity_check',{simple:true})!=='ok' || db.pragma('foreign_key_check').length) problems.push('Нарушена целостность БД');
    const present = new Set([...actual.keys()].map(k=>process.platform==='win32'?k.toLowerCase():k));
    for(const file of referencedFiles(db)) if(!present.has(file)) problems.push('Отсутствует связанный файл: '+file);
  } finally { db?.close(); fs.rmSync(temporary,{recursive:true,force:true}); }
  return {ok:!problems.length,problems,manifest};
}

export function verifyBackup(dir) {
  try { return verifySnapshot(dir); }
  catch(error) { return {ok:false,problems:[error.message]}; }
}

export async function restoreBackup(dir,{force=false}={}) {
  if(!force) throw Error('Для восстановления требуется --force');
  const lock = lockInstallation();
  const token = crypto.randomUUID();
  const staged = [config.databasePath,config.uploadsPath].map(p=>p+'.stage-'+token);
  try {
    recoverRestore();
    const verification = verifyBackup(dir);
    if(!verification.ok) throw Error('Копия повреждена: '+verification.problems.join('; '));
    const {manifest} = verification;
    fs.copyFileSync(path.join(dir,'infoteh.db'),staged[0],fs.constants.COPYFILE_EXCL);
    fs.mkdirSync(staged[1],{recursive:true});
    if(sha256(staged[0])!==manifest.database.sha256) throw Error('Копия БД изменилась');
    for(const f of manifest.uploads.files) {
      const dest=path.join(staged[1],f.path);
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      fs.copyFileSync(path.join(dir,'uploads',f.path),dest,fs.constants.COPYFILE_EXCL);
      if(sha256(dest)!==f.sha256) throw Error('Копия файла изменилась');
    }
    const safety=fs.existsSync(config.databasePath)?(await createSnapshot({label:'pre-restore',keep:Infinity})).target:null;
    installSnapshot(staged,token);
    return {restored:true,safety,manifest};
  } finally {
    try { for(const p of staged) fs.rmSync(p,{force:true,recursive:true}); }
    finally { lock.close(); }
  }
}
export default { createBackup, verifyBackup, restoreBackup, listBackups };
