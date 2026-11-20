// Восстановление из резервной копии.
// Запуск: npm run restore -- backups/backup-XXXX --force
import net from 'node:net';
import path from 'path';
import config from '../config.js';
import { restoreBackup, verifyBackup, listBackups } from '../lib/backup.js';

const args = process.argv.slice(2);
const dir = args.find((value) => !value.startsWith('--'));
const force = args.includes('--force');

if (!dir) {
  console.log('Использование: npm run restore -- <каталог копии> --force');
  console.log('Доступные копии:');
  for (const backup of listBackups()) console.log('  ' + backup.name);
  process.exit(1);
}

const target = path.resolve(config.backupPath, dir);
const verification = verifyBackup(target);

if (!verification.ok) {
  console.error('Копия не прошла проверку: ' + verification.problems.join('; '));
  process.exit(1);
}

if (!force) {
  console.error('Восстановление перезапишет рабочие данные.');
  console.error('Запустите повторно с флагом --force. Перед перезаписью будет создана страховочная копия.');
  process.exit(1);
}

try {
  // Защита и для серверов прежних версий, которые не держат maintenance-lock.
  const probe = net.createServer();
  await new Promise((resolve,reject) => {
    probe.once('error', () => reject(new Error('Остановите сервис перед восстановлением: порт занят')));
    probe.listen(config.port,config.host,()=>probe.close(resolve));
  });
  const result = await restoreBackup(target, { force: true });
  console.log(`Данные восстановлены из ${target}`);
  console.log(`Страховочная копия текущего состояния: ${result.safety}`);
  console.log('Перезапустите приложение: systemctl restart infoteh (или npm start).');
} catch (error) {
  console.error('Ошибка восстановления:', error.message);
  process.exit(1);
}
