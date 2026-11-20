import crypto from 'crypto';
import config from '../config.js';
import { AppError, badRequest } from './errors.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// HTTP-заголовки безопасности
// ---------------------------------------------------------------------------

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // В интерфейсе используются inline-обработчики (onclick), поэтому скрипты
  // разрешены с 'unsafe-inline'. Это осознанное ограничение, зафиксировано
  // в SECURITY_REPORT.md как остаточный риск.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );

  if (config.isProduction && process.env.ENABLE_HSTS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  res.removeHeader('X-Powered-By');
  next();
}

// ---------------------------------------------------------------------------
// CORS: только явно разрешённые источники (по умолчанию — без CORS)
// ---------------------------------------------------------------------------

export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;

  if (origin && config.trustedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(origin && config.trustedOrigins.includes(origin) ? 204 : 403);
  }

  next();
}

// ---------------------------------------------------------------------------
// CSRF: токен привязан к сессии, клиент передаёт его в заголовке X-CSRF-Token
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function ensureCsrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

export function rotateCsrfToken(req) {
  if (!req.session) return '';
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function tokensEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const expected = req.session && req.session.csrfToken;
  const provided = req.get('x-csrf-token') || (req.body && req.body._csrf);

  if (!expected || !provided || !tokensEqual(expected, provided)) {
    return next(new AppError(403, 'Недействительный CSRF-токен. Обновите страницу.', { code: 'CSRF' }));
  }

  next();
}

// ---------------------------------------------------------------------------
// Ограничение частоты запросов (в памяти процесса)
// ---------------------------------------------------------------------------

export function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  cleanup.unref?.();

  return function rateLimiter(req, res, next) {
    if (config.isTest) return next();

    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return next(new AppError(429, `Слишком много запросов. Повторите через ${retryAfter} с.`, { code: 'RATE_LIMIT' }));
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Защита от подбора пароля: попытки входа по IP+логину
// ---------------------------------------------------------------------------

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

export function loginKey(req, login) {
  return `${req.ip}|${String(login || '').toLowerCase()}`;
}

export function isLoginBlocked(req, login) {
  const key = loginKey(req, login);
  const entry = loginAttempts.get(key);
  if (!entry) return false;

  // Окно попыток истекло — счётчик сбрасывается.
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }

  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

export function recordLoginFailure(req, login) {
  const key = loginKey(req, login);
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, firstAt: now, blockedUntil: 0 };

  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }

  entry.count += 1;
  entry.blockedUntil = entry.count >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_WINDOW_MS : 0;
  loginAttempts.set(key, entry);

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    logger.warn('Блокировка подбора пароля', { login: String(login).slice(0, 32), ip: req.ip });
  }
}

export function resetLoginAttempts(req, login) {
  loginAttempts.delete(loginKey(req, login));
}

export function resetSecurityState() {
  loginAttempts.clear();
}

// ---------------------------------------------------------------------------
// Проверка источника изменяющих запросов (дополнительно к CSRF)
// ---------------------------------------------------------------------------

export function verifySameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  const candidates = [origin, referer].filter(Boolean);
  if (candidates.length === 0) return next(); // небраузерные клиенты, например curl в тестах

  const host = req.get('host');
  const allowed = new Set([
    ...config.trustedOrigins,
    `http://${host}`,
    `https://${host}`
  ]);

  const ok = candidates.some((value) => {
    try {
      const parsed = new URL(value);
      return allowed.has(parsed.origin);
    } catch {
      return false;
    }
  });

  if (!ok) {
    return next(new AppError(403, 'Запрос с недопустимого источника', { code: 'BAD_ORIGIN' }));
  }

  next();
}

export function requireJsonForMutations(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.is('multipart/form-data')) return next();
  if (req.is('application/json')) return next();
  if (req.is('text/csv') || req.is('text/plain')) return next();
  return next(badRequest('Неподдерживаемый тип содержимого запроса'));
}
