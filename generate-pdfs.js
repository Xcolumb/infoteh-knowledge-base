import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'infoteh.db');
const uploadsRoot = path.resolve(__dirname, 'uploads');
const force = process.argv.includes('--force');

if (!fs.existsSync(dbPath)) {
  console.error('База infoteh.db не найдена. Сначала выполните: npm run seed');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT "Название" as title, "Файл" as file
  FROM "Статья"
  WHERE "Файл" IS NOT NULL AND TRIM("Файл") <> ''
  ORDER BY "ID_статьи"
`).all();

db.close();

const documents = new Map();

for (const row of rows) {
  if (!documents.has(row.file)) {
    documents.set(row.file, row.title);
  }
}

if (documents.size === 0) {
  console.error('В базе нет статей с прикреплёнными файлами.');
  console.error('Сначала выполните: npm run seed');
  process.exit(1);
}

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

function transliterate(text) {
  return Array.from(text).map((char) => {
    const lower = char.toLowerCase();
    const mapped = CYRILLIC[lower];

    if (mapped === undefined) return char;
    if (char === lower) return mapped;

    return mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }).join('');
}

function toPdfText(text) {
  return transliterate(String(text))
    .replace(/[«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/№/g, 'No. ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapePdfText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapText(text, maxLength) {
  const words = text.split(' ').filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= maxLength) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function buildPdf(title, file) {
  const titleLines = wrapText(toPdfText(title), 46).slice(0, 3);
  const fileName = path.basename(file);

  const operations = [];
  let y = 790;

  operations.push('0.15 0.65 0.23 RG 2 w 56 748 m 539 748 l S');

  for (const line of titleLines) {
    operations.push(`BT /F1 20 Tf 56 ${y} Td (${escapePdfText(line)}) Tj ET`);
    y -= 26;
  }

  y -= 10;

  const body = [
    'INFOTEH - KNOWLEDGE BASE FOR INSTALLERS',
    'Demo instruction document',
    '',
    'This PDF was generated automatically for the portfolio demo.',
    'Replace it with the real production instruction if needed.'
  ];

  for (const line of body) {
    if (line) {
      operations.push(`BT /F1 11 Tf 56 ${y} Td (${escapePdfText(line)}) Tj ET`);
    }
    y -= 20;
  }

  operations.push(`BT /F1 9 Tf 56 60 Td (${escapePdfText(`File: ${fileName}`)}) Tj ET`);
  operations.push('BT /F1 9 Tf 470 60 Td (Page 1 of 1) Tj ET');

  const content = operations.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';

  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

fs.mkdirSync(uploadsRoot, { recursive: true });

let created = 0;
let skipped = 0;

for (const [file, title] of documents) {
  const normalized = String(file).replace(/\\/g, '/');

  if (!/^\/?uploads\//.test(normalized)) {
    console.warn(`Пропущен некорректный путь: ${file}`);
    continue;
  }

  const target = path.resolve(__dirname, normalized.replace(/^\/+/, ''));

  if (target !== uploadsRoot && !target.startsWith(uploadsRoot + path.sep)) {
    console.warn(`Пропущен путь вне uploads/: ${file}`);
    continue;
  }

  const buffer = buildPdf(title, normalized);

  if (fs.existsSync(target) && !force) {
    skipped += 1;
    console.log(`  ${normalized} — уже существует, пропущен`);
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  created += 1;

  console.log(`  ${normalized} — ${(buffer.length / 1024).toFixed(1)} КБ`);
}

console.log('');
console.log(`Создано PDF-файлов: ${created}, пропущено: ${skipped}.`);

if (created === 0 && skipped === 0) {
  console.error('Ни один файл не создан. Проверьте пути в таблице "Статья".');
  process.exit(1);
}
