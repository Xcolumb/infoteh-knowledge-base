import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

// Локальная конвертация старых DOC/XLS в PDF через LibreOffice (headless).
// Никакие внешние сервисы не используются. Если LibreOffice не установлен,
// просмотр честно помечается как недоступный с предложением скачать файл.

const TIMEOUT_MS = 30_000;
const MAX_PDF_BYTES = 40 * 1024 * 1024;

let detected = null;

function candidates() {
  return [
    process.env.LIBREOFFICE_PATH,
    'soffice',
    'libreoffice',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe'
  ].filter(Boolean);
}

export function findLibreOffice() {
  if (detected !== null) return detected;

  for (const candidate of candidates()) {
    try {
      const result = spawnSync(candidate, ['--version'], { timeout: 5_000, encoding: 'utf8' });
      if (result.status === 0) {
        detected = { available: true, binary: candidate, version: String(result.stdout || '').trim().split('\n')[0] };
        return detected;
      }
    } catch {
      // пробуем следующий вариант
    }
  }

  detected = {
    available: false,
    binary: null,
    hint: 'Установите LibreOffice на сервер (пакет libreoffice-core / libreoffice-writer / libreoffice-calc) или укажите LIBREOFFICE_PATH.'
  };

  return detected;
}

export function convertToPdf(sourcePath) {
  const office = findLibreOffice();
  if (!office.available) {
    throw Object.assign(new Error('Предпросмотр этого формата недоступен: на сервере не установлен LibreOffice'), {
      code: 'LIBREOFFICE_UNAVAILABLE',
      hint: office.hint
    });
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infoteh-preview-'));

  try {
    const result = spawnSync(
      office.binary,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', workDir, sourcePath],
      { timeout: TIMEOUT_MS, encoding: 'utf8' }
    );

    if (result.error && result.error.code === 'ETIMEDOUT') {
      throw Object.assign(new Error('Превышено время преобразования документа (30 с)'), { code: 'CONVERT_TIMEOUT' });
    }

    const expected = path.join(workDir, `${path.parse(sourcePath).name}.pdf`);
    if (!fs.existsSync(expected)) {
      throw Object.assign(new Error('Не удалось преобразовать документ в PDF'), { code: 'CONVERT_FAILED' });
    }

    const stats = fs.statSync(expected);
    if (stats.size > MAX_PDF_BYTES) {
      throw Object.assign(new Error('Результат преобразования слишком большой для просмотра'), { code: 'CONVERT_TOO_LARGE' });
    }

    return fs.readFileSync(expected);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function randomTempName(extension = '') {
  return `${crypto.randomBytes(12).toString('hex')}${extension}`;
}

export default { findLibreOffice, convertToPdf };
