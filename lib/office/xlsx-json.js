import { readZipEntry } from '../zip.js';

// Преобразование XLSX в данные для табличного просмотра.
// Формулы не вычисляются и не исполняются: используется только сохранённое значение.
const LIMITS = { sheets: 25, rows: 500, cols: 40, cellChars: 500 };

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/);
  if (!letters) return 0;
  let index = 0;
  for (const char of letters[0]) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function readSharedStrings(buffer) {
  const xml = readZipEntry(buffer, 'xl/sharedStrings.xml');
  if (!xml) return [];

  const strings = [];
  for (const match of String(xml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const text = Array.from(match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))
      .map((part) => decodeEntities(part[1]))
      .join('');
    strings.push(text);
  }

  return strings;
}

function readWorkbookSheets(buffer) {
  const workbook = readZipEntry(buffer, 'xl/workbook.xml');
  if (!workbook) {
    throw Object.assign(new Error('Файл не похож на книгу Excel (нет xl/workbook.xml)'), { code: 'XLSX_INVALID' });
  }

  const relsXml = readZipEntry(buffer, 'xl/_rels/workbook.xml.rels');
  const rels = new Map();

  if (relsXml) {
    for (const match of String(relsXml).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /Id="([^"]+)"/.exec(match[1]);
      const target = /Target="([^"]+)"/.exec(match[1]);
      if (id && target) rels.set(id[1], target[1]);
    }
  }

  const sheets = [];
  for (const match of String(workbook).matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = match[1];
    const name = /name="([^"]*)"/.exec(attrs);
    const relId = /r:id="([^"]+)"/.exec(attrs);
    if (!name) continue;

    const target = relId ? rels.get(relId[1]) : null;
    const path = target
      ? `xl/${String(target).replace(/^\.?\//, '').replace(/^xl\//, '')}`
      : null;

    sheets.push({ name: decodeEntities(name[1]), path });
  }

  return sheets;
}

function readSheet(buffer, path, sharedStrings) {
  const xml = readZipEntry(buffer, path);
  if (!xml) return { rows: [], truncated: false };

  const rows = [];
  let truncated = false;

  for (const rowMatch of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= LIMITS.rows) {
      truncated = true;
      break;
    }

    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] || '';
      const inner = cellMatch[2] || '';
      const reference = /r="([A-Z]+\d+)"/.exec(attrs);
      const type = /t="([^"]+)"/.exec(attrs);
      const index = reference ? columnIndex(reference[1]) : cells.length;

      if (index >= LIMITS.cols) {
        truncated = true;
        continue;
      }

      let value = '';

      if (type && type[1] === 's') {
        const shared = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const position = shared ? Number(shared[1]) : -1;
        value = Number.isInteger(position) && sharedStrings[position] !== undefined ? sharedStrings[position] : '';
      } else if (type && type[1] === 'inlineStr') {
        value = Array.from(inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map((part) => decodeEntities(part[1])).join('');
      } else if (type && type[1] === 'b') {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = raw && raw[1] === '1' ? 'ИСТИНА' : 'ЛОЖЬ';
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = raw ? decodeEntities(raw[1]) : '';
      }

      value = String(value).slice(0, LIMITS.cellChars);
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }

    if (cells.length) rows.push(cells);
  }

  return { rows, truncated };
}

export function xlsxToSheets(buffer) {
  const sharedStrings = readSharedStrings(buffer);
  const sheets = readWorkbookSheets(buffer).slice(0, LIMITS.sheets);
  const warnings = [];

  const result = sheets.map((sheet) => {
    try {
      const data = readSheet(buffer, sheet.path, sharedStrings);
      if (data.truncated) warnings.push(`Лист «${sheet.name}» показан частично`);
      return { name: sheet.name, rows: data.rows, truncated: data.truncated };
    } catch {
      return { name: sheet.name, rows: [], truncated: false, error: 'Не удалось прочитать лист' };
    }
  });

  return {
    sheets: result,
    limits: LIMITS,
    warnings: [...new Set(warnings)]
  };
}

export default xlsxToSheets;
