import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';

// Отдельный SQLite-файл координирует смену комплекта даже при переименовании самой рабочей БД.
// ОС освобождает блокировку при аварийном завершении процесса.
export function lockInstallation(exclusive = true) {
  fs.mkdirSync(path.dirname(config.databasePath),{recursive:true});
  const lock = new Database(config.databasePath+'.maintenance-lock',{timeout:0});
  try { lock.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN'); lock.prepare('SELECT count(*) FROM sqlite_master').get(); }
  catch (error) { lock.close(); throw new Error('Остановите сервер и дождитесь завершения обслуживания',{cause:error}); }
  return lock;
}

function journalPath() { return config.databasePath+'.restore-journal'; }
function targets() { return [config.databasePath,config.uploadsPath,...['-wal','-shm','-journal'].map(s=>config.databasePath+s)]; }

// До удаления журнала восстановление считается незавершённым. Откат повторяем.
export function recoverRestore() {
  if (!fs.existsSync(journalPath())) return;
  const {token, existed} = JSON.parse(fs.readFileSync(journalPath(),'utf8'));
  if (!/^[0-9a-f-]{36}$/.test(token) || !Array.isArray(existed) || existed.length !== targets().length) throw Error('Повреждён журнал восстановления');
  for (const [i,target] of targets().entries()) {
    const old = target+'.previous-'+token;
    if (fs.existsSync(old)) {
      fs.rmSync(target,{recursive:true,force:true});
      fs.renameSync(old,target);
    } else if (!existed[i]) fs.rmSync(target,{recursive:true,force:true});
  }
  fs.unlinkSync(journalPath());
}

export function installSnapshot(staged,token) {
  const paths = targets();
  const existed = paths.map(p=>fs.existsSync(p));
  const journal = journalPath();
  const temp = journal+'.'+token;
  fs.writeFileSync(temp,JSON.stringify({token,existed}),{flag:'wx',flush:true});
  fs.renameSync(temp,journal);
  try {
    for (const [i,target] of paths.entries()) {
      if (existed[i]) fs.renameSync(target,target+'.previous-'+token);
      if (i<2) fs.renameSync(staged[i],target);
    }
    fs.unlinkSync(journal);
  } catch (error) { recoverRestore(); throw error; }
  for (const target of paths) fs.rmSync(target+'.previous-'+token,{recursive:true,force:true});
}
