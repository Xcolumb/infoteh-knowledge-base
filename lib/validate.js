import { badRequest } from './errors.js';
import { ALLOWED_UPLOAD_EXTENSIONS } from './constants.js';

const COMMON_PASSWORDS = new Set([
  '123456', '123456789', 'qwerty', 'password', 'admin', 'admin123', '12345',
  'qwerty123', '1q2w3e4r', 'password1', 'letmein', 'welcome', 'монолит'
]);

export function text(value, { field = 'Поле', required = false, max = 2000 } = {}) {
  const result = value === undefined || value === null ? '' : String(value).trim();

  if (!result) {
    if (required) throw badRequest(`${field}: обязательное поле`);
    return null;
  }

  if (result.length > max) {
    throw badRequest(`${field}: не длиннее ${max} символов`);
  }

  return result;
}

export function id(value, { field = 'Идентификатор', required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field}: обязательное поле`);
    return null;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw badRequest(`${field}: некорректное значение`);
  }

  return number;
}

export function isoDate(value, { field = 'Дата', required = false } = {}) {
  const result = text(value, { field, required, max: 10 });
  if (!result) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw badRequest(`${field}: формат ГГГГ-ММ-ДД`);
  }

  const date = new Date(`${result}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`${field}: некорректная дата`);
  }

  return result;
}

export function oneOf(value, allowed, { field = 'Значение', required = true } = {}) {
  const result = text(value, { field, required, max: 200 });
  if (!result) return null;

  if (!allowed.includes(result)) {
    throw badRequest(`${field}: допустимые значения — ${allowed.join(', ')}`);
  }

  return result;
}

export function boolFlag(value) {
  if (value === true || value === 'true' || value === '1' || value === 'on') return true;
  return false;
}

export function password(value, { tabNumber = '', field = 'Пароль' } = {}) {
  const result = String(value ?? '');

  if (result.length < 10) {
    throw badRequest(`${field}: не короче 10 символов`);
  }

  if (result.length > 128) {
    throw badRequest(`${field}: не длиннее 128 символов`);
  }

  if (!/[A-Za-zА-Яа-яЁё]/.test(result) || !/\d/.test(result)) {
    throw badRequest(`${field}: должен содержать буквы и цифры`);
  }

  if (COMMON_PASSWORDS.has(result.toLowerCase())) {
    throw badRequest(`${field}: слишком простой пароль`);
  }

  if (tabNumber && result.toLowerCase().includes(String(tabNumber).toLowerCase())) {
    throw badRequest(`${field}: не должен содержать табельный номер`);
  }

  if (/^(infoteh|balakovo|инфотех|балаково)/i.test(result)) {
    throw badRequest(`${field}: не должен содержать название организации`);
  }

  return result;
}

export function uploadExtension(originalName) {
  const name = String(originalName || '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return name.slice(dot).toLowerCase();
}

// Multer/Busboy отдаёт originalname как UTF-8-байты, декодированные как Latin-1:
// «Исполнительная…docx» превращается в «Ð˜ÑÐ¿Ð¾Ð»Ð½Ð¸Ñ‚ÐµÐ»ÑŒÐ½Ð°Ñ…docx».
// Функция восстанавливает исходное имя, но только если перекодировка однозначна:
// уже корректные UTF-8 имена и латиница с диакритикой остаются без изменений.
export function decodeUploadFileName(raw) {
  const name = String(raw ?? '');
  if (!name) return name;
  if (!/[^\x00-\x7F]/.test(name)) return name;          // чистая латиница/ASCII
  if (/[А-Яа-яЁё]/.test(name)) return name;              // кириллица уже корректна

  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  if (decoded.includes('\uFFFD')) return name;           // не UTF-8 — оставляем как есть
  if (!decoded || decoded === name) return name;

  // Признак «мojibake»: преобладание символов Latin-1 в диапазоне C0–FF.
  const latin1Chars = Array.from(name).filter((char) => {
    const code = char.codePointAt(0);
    return code >= 0xC0 && code <= 0xFF;
  }).length;

  return latin1Chars > 0 ? decoded : name;
}

export function isAllowedUpload(originalName) {
  const extension = uploadExtension(originalName);
  return Boolean(extension) && ALLOWED_UPLOAD_EXTENSIONS.includes(extension);
}

export function safeOriginalName(originalName) {
  // Оригинальное имя сохраняется в БД (для отображения и скачивания),
  // но очищается от управляющих символов и разделителей пути.
  return decodeUploadFileName(originalName)
    .replace(/[\\/\r\n\t\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255) || 'file';
}
