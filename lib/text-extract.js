import zlib from 'zlib';
import { readZipEntry, readZipEntries } from './zip.js';
import { uploadExtension } from './validate.js';

// Извлечение текста из поддерживаемых форматов без внешних зависимостей.
// Важно: для сканированных PDF текст не «выдумывается» — возвращается флаг
// «требует OCR», чтобы интерфейс честно показывал состояние документа.

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(xml, { breaks = true } = {}) {
  let text = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, breaks ? ' ' : '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  text = decodeXmlEntities(text);
  return text.trim();
}

function extractDocx(buffer) {
  const documentXml = readZipEntry(buffer, 'word/document.xml');
  if (!documentXml) return { text: '', requiresOcr: false, engine: 'docx', note: 'Документ Word без основного текста' };

  return { text: stripTags(documentXml.toString('utf8')), requiresOcr: false, engine: 'docx' };
}

function extractXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const parts = [];

  const sharedStrings = entries.get('xl/sharedStrings.xml');
  if (sharedStrings) {
    const xml = sharedStrings.data.toString('utf8');
    const strings = Array.from(xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((match) => decodeXmlEntities(match[1]));
    parts.push(strings.join('\n'));
  }

  for (const [name, entry] of entries) {
    if (!name.startsWith('xl/worksheets/') || !name.endsWith('.xml')) continue;
    const xml = entry.data.toString('utf8');
    const cells = Array.from(xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((match) => decodeXmlEntities(match[1]));
    if (cells.length) parts.push(cells.join('\n'));
  }

  return { text: parts.join('\n\n').trim(), requiresOcr: false, engine: 'xlsx' };
}

function decodePdfStreams(buffer) {
  const text = [];

  // Потоки PDF в бинарном виде: ищем ключевые слова stream/endstream,
  // пробуем распаковать FlateDecode. Остальные фильтры не поддерживаются.
  const source = buffer.toString('latin1');
  const regex = /stream\r?\n([\s\S]*?)endstream/g;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const raw = Buffer.from(match[1], 'latin1');
    let decoded = null;

    try {
      decoded = zlib.inflateSync(raw);
    } catch {
      try {
        decoded = zlib.inflateRawSync(raw);
      } catch {
        decoded = null;
      }
    }

    if (decoded) text.push(decoded.toString('latin1'));
  }

  return text.join('\n');
}

function pdfTextFromContent(content) {
  const chunks = [];
  const regex = /\((?:\\.|[^\\()])*\)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const raw = match[0].slice(1, -1);
    chunks.push(raw
      .replace(/\\([nrtbf()\\])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[char] || char))
      .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
  }

  return chunks.join(' ');
}

function extractPdf(buffer) {
  const rawText = pdfTextFromContent(decodePdfStreams(buffer));
  const cleaned = rawText.replace(/[^\x20-\x7E\u0400-\u04FF]/g, ' ').replace(/\s+/g, ' ').trim();

  // Если текста мало — документ, скорее всего, сканированный.
  return {
    text: cleaned,
    requiresOcr: cleaned.length < 40,
    engine: 'pdf',
    note: cleaned.length < 40 ? 'Текстовый слой PDF отсутствует или слишком короткий — требуется OCR' : undefined
  };
}

export function extractText(buffer, extensionOrName) {
  const extension = extensionOrName.startsWith('.') ? extensionOrName.toLowerCase() : uploadExtension(extensionOrName);

  try {
    switch (extension) {
      case '.docx':
        return { ...extractDocx(buffer), supported: true };
      case '.xlsx':
        return { ...extractXlsx(buffer), supported: true };
      case '.pdf':
        return { ...extractPdf(buffer), supported: true };
      case '.txt':
      case '.md':
      case '.csv':
        return { text: buffer.toString('utf8').trim(), requiresOcr: false, engine: 'text', supported: true };
      case '.doc':
      case '.xls':
        return {
          text: '',
          requiresOcr: false,
          engine: 'legacy-office',
          supported: false,
          note: 'Старый формат Office (DOC/XLS): извлечение текста не поддерживается, требуется конвертация в DOCX/XLSX'
        };
      default:
        return { text: '', requiresOcr: false, engine: 'unknown', supported: false, note: 'Формат не поддерживается' };
    }
  } catch (error) {
    return {
      text: '',
      requiresOcr: false,
      engine: extension,
      supported: false,
      error: error.message,
      note: 'Не удалось извлечь текст'
    };
  }
}

export default extractText;
