// Централизованная конфигурация приложения.
// Все значения читаются из переменных окружения (.env рядом с server.js).
// Секреты в коде не хранятся: при отсутствии обязательных значений в production
// приложение отказывается запускаться.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Минимальный парсер .env (без внешних зависимостей).
// Уже установленные переменные окружения имеют приоритет.
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv(path.join(__dirname, '.env'));

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Не задана обязательная переменная окружения ${name}. ` +
      'Скопируйте .env.example в .env и заполните значения (см. DEPLOYMENT_RU_VPS.md).'
    );
  }
  return value;
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolvePath(name, fallback) {
  return path.resolve(__dirname, process.env[name] || fallback);
}

const sessionSecret = isProduction
  ? required('SESSION_SECRET')
  : (process.env.SESSION_SECRET || 'dev-only-insecure-session-secret-change-me');

if (isProduction && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET в production должен быть не короче 32 символов.');
}

const trustedOrigins = String(process.env.TRUSTED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

export const config = {
  env,
  isProduction,
  isTest: env === 'test',
  port: int('PORT', 3001),
  host: process.env.HOST || '127.0.0.1',
  sessionSecret,
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'infoteh.sid',
  sessionTimeoutMinutes: int('SESSION_TIMEOUT_MINUTES', 480),
  databasePath: resolvePath('DATABASE_PATH', 'infoteh.db'),
  uploadsPath: resolvePath('UPLOADS_PATH', 'uploads'),
  backupPath: resolvePath('BACKUP_PATH', 'backups'),
  logPath: resolvePath('LOG_PATH', 'logs'),
  maxUploadBytes: int('MAX_UPLOAD_MB', 20) * 1024 * 1024,
  backupKeep: int('BACKUP_KEEP', 14),
  trustProxy: bool('TRUST_PROXY', false),
  cookieSecure: bool('COOKIE_SECURE', isProduction),
  allowDemoAccounts: !isProduction && bool('ALLOW_DEMO_ACCOUNTS', true),
  trustedOrigins,
  // Внешние ИИ-провайдеры по умолчанию отключены: включение — отдельным решением.
  ai: {
    enabled: bool('AI_ENABLED', false),
    provider: process.env.AI_PROVIDER || 'none',
    baseUrl: process.env.AI_BASE_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || ''
  },
  // Ежедневная генерация уведомлений о сроках (минуты между проходами).
  notificationsIntervalMinutes: int('NOTIFICATIONS_INTERVAL_MINUTES', 60)
};

export function describeConfig() {
  return {
    env: config.env,
    port: config.port,
    database: config.databasePath,
    uploads: config.uploadsPath,
    backups: config.backupPath,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    demoAccounts: config.allowDemoAccounts,
    aiEnabled: config.ai.enabled
  };
}

export default config;
