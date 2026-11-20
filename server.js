import { lockInstallation, recoverRestore } from './lib/restore-install.js';
// Точка входа production-сервера.
// Конфигурация берётся из .env (см. .env.example и DEPLOYMENT_RU_VPS.md).
import config from './config.js';
import { openDatabase } from './lib/db.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';
import { ftsAvailable, rebuildSearchIndex } from './lib/search.js';
import { runNotificationScheduler } from './lib/notifications.js';

const recoveryLock = lockInstallation();
try { recoverRestore(); } finally { recoveryLock.close(); }
const installationLock = lockInstallation(false);
process.on('exit', () => installationLock.close());
const db = openDatabase();
const { app } = createApp({ db });

// Индекс поиска строится при первом запуске и после восстановления из копии.
try {
  if (ftsAvailable(db)) {
    const indexed = db.prepare('SELECT COUNT(*) as count FROM "Поиск"').get().count;
    if (indexed === 0) rebuildSearchIndex(db);
  }
} catch (error) {
  logger.warn('Не удалось построить индекс поиска', { error: error.message });
}

// Ежедневные напоминания о сроках (внутри приложения).
runNotificationScheduler(db, config.notificationsIntervalMinutes);

const server = app.listen(config.port, config.host, () => {
  logger.info('Сервер запущен', {
    url: `http://${config.host}:${config.port}`,
    env: config.env,
    database: config.databasePath,
    uploads: config.uploadsPath
  });
});

function shutdown(signal) {
  logger.info('Остановка сервера', { signal });
  server.close(() => {
    try {
      db.close();
    } catch (error) {
      logger.warn('Ошибка закрытия БД', { error: error.message });
    }
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, db, server };
