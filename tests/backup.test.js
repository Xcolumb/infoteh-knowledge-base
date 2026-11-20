import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('резервное копирование и восстановление', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infoteh-backup-'));
  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
  process.env.DATABASE_PATH = path.join(dir, 'data.db');
  process.env.UPLOADS_PATH = path.join(dir, 'uploads');
  process.env.BACKUP_PATH = path.join(dir, 'backups');
  process.env.LOG_PATH = path.join(dir, 'logs');
  process.env.BACKUP_KEEP = '3';

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { openDatabase } = await import('../lib/db.js');
  const { createBackup, verifyBackup, restoreBackup } = await import('../lib/backup.js');

  const db = openDatabase();
  db.prepare(`INSERT INTO "Объект" ("Название", "Адрес", "Заказчик", "updated_at") VALUES ('Объект копии', 'адрес', 'заказчик', datetime('now','localtime'))`).run();
  const doc = db.prepare(`
    INSERT INTO "Документ_ПТО" ("Тип", "Название", "ID_объекта", "Статус", "Файл", "ID_автора", "Версия", "Актуализирован", "updated_at")
    VALUES ('ППР', 'Документ копии', 1, 'Черновик', 'uploads/file.pdf', NULL, 1, date('now','localtime'), datetime('now','localtime'))
  `).run();
  fs.mkdirSync(process.env.UPLOADS_PATH, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOADS_PATH, 'file.pdf'), 'BACKUP-FILE');
  db.close();

  let backupDir;

  await t.test('копия создаётся и проходит проверку', async () => {
    const result = await createBackup({ label: 'test' });
    backupDir = result.target;

    assert.equal(result.manifest.database.integrity, 'ok');
    assert.ok(fs.existsSync(path.join(backupDir, 'infoteh.db')));
    assert.ok(fs.existsSync(path.join(backupDir, 'uploads', 'file.pdf')));

    const verification = verifyBackup(backupDir);
    assert.equal(verification.ok, true, verification.problems.join('; '));
  });

  await t.test('повреждённая копия не проходит проверку', async () => {
    const copy = path.join(dir, 'corrupted');
    fs.cpSync(backupDir, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'uploads', 'file.pdf'), 'TAMPERED');

    const verification = verifyBackup(copy);
    assert.equal(verification.ok, false);
    assert.ok(verification.problems.some((problem) => problem.includes('контрольная сумма')));

    fs.rmSync(copy, { recursive: true, force: true });
  });

  await t.test('восстановление возвращает данные', async () => {
    await createBackup({label:'second'});
    await createBackup({label:'third'});
    fs.writeFileSync(path.join(process.env.UPLOADS_PATH,'extra.pdf'),'EXTRA');
    const dbBefore = openDatabase();
    dbBefore.prepare(`DELETE FROM "Документ_ПТО"`).run();
    dbBefore.prepare(`DELETE FROM "Объект"`).run();
    dbBefore.close();

    const result = await restoreBackup(backupDir, { force: true });
    assert.equal(result.restored, true);
    assert.ok(fs.existsSync(backupDir));
    assert.equal(fs.existsSync(path.join(process.env.UPLOADS_PATH,'extra.pdf')),false);
    assert.ok(fs.existsSync(result.safety), 'должна быть создана страховочная копия');

    const restored = openDatabase();
    const documents = restored.prepare('SELECT COUNT(*) as c FROM "Документ_ПТО"').get().c;
    const objects = restored.prepare('SELECT COUNT(*) as c FROM "Объект"').get().c;
    const file = fs.readFileSync(path.join(process.env.UPLOADS_PATH, 'file.pdf'), 'utf8');
    restored.close();

    assert.equal(objects, 1);
    assert.equal(documents, 1);
    assert.equal(file, 'BACKUP-FILE');
  });

  await t.test('остановка процесса между заменами позволяет вернуть прежний комплект',async()=>{
    fs.writeFileSync(path.join(process.env.UPLOADS_PATH,'prior.txt'),'before');
    const child = spawnSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs';
      import {restoreBackup} from './lib/backup.js';
      const rename = fs.renameSync;
      fs.renameSync = (a,b) => {
        rename(a,b);
        if (a === process.env.UPLOADS_PATH) process.exit(77);
      };
      await restoreBackup(process.argv[1],{force:true});
    `,backupDir],{encoding:'utf8'});
    assert.equal(child.status,77,child.stderr);
    const {recoverRestore,lockInstallation}=await import('../lib/restore-install.js');
    const lock=lockInstallation();
    try { recoverRestore(); recoverRestore(); } finally { lock.close(); }
    assert.equal(fs.readFileSync(path.join(process.env.UPLOADS_PATH,'prior.txt'),'utf8'),'before');
    const db=openDatabase();
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    db.close();
  });

  await t.test('без --force восстановление отклоняется', async () => {
    await assert.rejects(() => restoreBackup(backupDir, { force: false }), /force/);
  });
});
