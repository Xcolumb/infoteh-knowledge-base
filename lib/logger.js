import fs from 'fs';
import path from 'path';
import config from '../config.js';

const REDACTED_KEYS = ['password', 'пароль', 'token', 'secret', 'authorization', 'cookie', 'apikey', 'api_key'];

function redact(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = REDACTED_KEYS.some((needle) => key.toLowerCase().includes(needle))
      ? '***'
      : redact(item, depth + 1);
  }
  return result;
}

function ensureLogDir() {
  if (!fs.existsSync(config.logPath)) {
    fs.mkdirSync(config.logPath, { recursive: true });
  }
}

function write(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(Object.keys(meta).length ? { meta: redact(meta) } : {})
  };

  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (!config.isTest) {
    console.log(line);
  }

  if (config.isTest) return;

  try {
    ensureLogDir();
    fs.appendFileSync(path.join(config.logPath, 'app.log'), `${line}\n`, 'utf8');
  } catch (error) {
    console.error('Не удалось записать журнал:', error.message);
  }
}

export const logger = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  debug: (message, meta) => {
    if (!config.isProduction) write('debug', message, meta);
  }
};

export default logger;
