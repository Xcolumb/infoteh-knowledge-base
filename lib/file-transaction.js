import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import { fileMeta, resolveStoredPath } from './files.js';
import { logger } from './logger.js';

export function referencedFiles(db) {
  const names = new Set();
  for (const table of ['Документ_ПТО','Редакция_ПТО','Статья','Вложение_замечания']) {
    for (const file of db.prepare('SELECT DISTINCT Файл FROM '+table+' WHERE Файл IS NOT NULL AND Файл <> ?').pluck().iterate('')) {
      const name = path.basename(file.replaceAll('\\','/'));
      names.add(process.platform === 'win32' ? name.toLowerCase() : name);
    }
  }
  return names;
}

function journal() { return path.join(config.uploadsPath,'.pending-files'); }

function track(file) {
  const name = path.basename(resolveStoredPath(file));
  fs.mkdirSync(journal(),{recursive:true});
  fs.closeSync(fs.openSync(path.join(journal(),name),'a'));
}

// Маркер переживает откат SQLite и остановку между COMMIT и удалением.
// Второй писатель не может опубликовать или удалить файл во время сверки.
export function recoverFiles(db) {
  if (!fs.existsSync(journal())) return;
  db.transaction(()=>{
    const entries = fs.readdirSync(journal());
    if (!entries.length) return;
    const keep = referencedFiles(db);
    for (const name of entries) {
      if (name.endsWith('.part')) continue;
      const marker = path.join(journal(),name);
      try {
        const target = resolveStoredPath(name);
        fs.rmSync(marker+'.part',{force:true});
        if (!keep.has(process.platform === 'win32' ? name.toLowerCase() : name)) fs.rmSync(target,{force:true});
        fs.unlinkSync(marker);
      } catch (error) {
        logger.warn('Очистка файла отложена',{error:error.message});
      }
    }
  }).immediate();
}

export function fileTransaction(db,file,change) {
  try {
    return db.transaction(()=>{
      let meta = null;
      if (file) {
        file.filename = randomUUID()+path.extname(file.originalname).toLowerCase();
        meta = fileMeta(file);
        track(meta.storedPath);
        const temp = path.join(journal(),file.filename+'.part');
        fs.writeFileSync(temp,file.buffer,{flag:'wx',flush:true});
        fs.renameSync(temp,resolveStoredPath(meta.storedPath));
      }
      return change(meta,track);
    }).immediate();
  } finally {
    try { recoverFiles(db); } catch (error) { logger.warn('Сверка файлов отложена',{error:error.message}); }
  }
}
