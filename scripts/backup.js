// Резервное копирование: БД (online backup) + файлы uploads + manifest с контрольными суммами.
// Запуск: npm run backup
import config from '../config.js';
import { createBackup, verifyBackup } from '../lib/backup.js';

const label = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : '';

try {
  const result = await createBackup({ label });
  const verification = verifyBackup(result.target);

  console.log(`Резервная копия: ${result.target}`);
  console.log(`  БД: ${(result.manifest.database.size / 1024).toFixed(1)} КБ, integrity: ${result.manifest.database.integrity}`);
  console.log(`  Файлов: ${result.manifest.uploads.count} (${(result.manifest.uploads.totalSize / 1024 / 1024).toFixed(2)} МБ)`);
  console.log(`  Проверка копии: ${verification.ok ? 'успешно' : 'ОШИБКИ: ' + verification.problems.join('; ')}`);
  console.log(`  Глубина хранения: ${config.backupKeep} копий${result.removed.length ? `, удалено старых: ${result.removed.length}` : ''}`);

  process.exit(verification.ok ? 0 : 1);
} catch (error) {
  console.error('Ошибка резервного копирования:', error.message);
  process.exit(1);
}
