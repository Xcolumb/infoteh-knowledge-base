import crypto from 'crypto';

// Ошибка приложения с HTTP-статусом и машинным кодом.
// Технические подробности остаются в журнале, пользователь видит понятный текст.
export class AppError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = options.code || 'APP_ERROR';
    this.details = options.details;
    this.expose = options.expose !== false;
  }
}

export const badRequest = (message, details) => new AppError(400, message, { code: 'BAD_REQUEST', details });
export const unauthorized = (message = 'Требуется авторизация') => new AppError(401, message, { code: 'UNAUTHORIZED' });
export const forbidden = (message = 'Недостаточно прав для этого действия') => new AppError(403, message, { code: 'FORBIDDEN' });
export const notFound = (message = 'Запись не найдена') => new AppError(404, message, { code: 'NOT_FOUND' });
export const conflict = (message, details) => new AppError(409, message, { code: 'CONFLICT', details });

export function requestId() {
  return crypto.randomBytes(8).toString('hex');
}

// Обёртка для async-обработчиков Express 5.
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
