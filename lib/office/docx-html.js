import { readZipEntry, readZipEntries } from '../zip.js';

// Безопасное преобразование DOCX в простой HTML.
// HTML собирается только из разрешённых тегов, текст всегда экранируется,
// поэтому документ не может внедрить скрипты (XSS) или макросы.

const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function readRelations(buffer) {
  const relations = new Map();
  const xml = readZipEntry(buffer, 'word/_rels/document.xml.rels');
  if (!xml) return relations;

  for (const match of String(xml).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = match[1];
    const id = /Id="([^"]+)"/.exec(attrs);
    const target = /Target="([^"]+)"/.exec(attrs);
    if (id && target) relations.set(id[1], target[1]);
  }

  return relations;
}

function collectImages(buffer, relations, warnings) {
  const images = new Map();
  let total = 0;

  for (const [id, target] of relations) {
    const extension = String(target).split('.').pop().toLowerCase();
    if (!IMAGE_MIME[extension]) continue;

    try {
      const entry = readZipEntry(buffer, `word/${String(target).replace(/^\.?\//, '')}`);
      if (!entry) continue;
      if (entry.length > MAX_IMAGE_BYTES || total + entry.length > 8 * 1024 * 1024) {
        warnings.push('Часть изображений пропущена из-за размера');
        continue;
      }
      total += entry.length;
      images.set(id, `data:${IMAGE_MIME[extension]};base64,${entry.toString('base64')}`);
    } catch {
      warnings.push('Не удалось прочитать изображение из документа');
    }
  }

  return images;
}

function renderRun(runXml, images) {
  const textMatches = Array.from(runXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g));
  const breaks = (runXml.match(/<w:br\b/g) || []).length;
  const tabs = (runXml.match(/<w:tab\b/g) || []).length;
  const imageIds = Array.from(runXml.matchAll(/<a:blip[^>]*r:embed="([^"]+)"/g)).map((match) => match[1]);

  let html = '';

  for (const match of textMatches) {
    html += escapeHtml(decodeEntities(match[1]));
  }

  html += '<br>'.repeat(breaks);
  html += '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(tabs);

  for (const imageId of imageIds) {
    const source = images.get(imageId);
    if (source) {
      html += `<img class="docx-image" src="${source}" alt="Изображение документа">`;
    }
  }

  if (!html.trim()) return '';

  const bold = /<w:b(?:\s[^>]*)?\/>/.test(runXml);
  const italic = /<w:i(?:\s[^>]*)?\/>/.test(runXml);
  const underline = /<w:u\b[^>]*\/?>/.test(runXml);

  if (underline) html = `<u>${html}</u>`;
  if (italic) html = `<em>${html}</em>`;
  if (bold) html = `<strong>${html}</strong>`;

  return html;
}

function renderParagraph(paragraphXml, images, { listDepth = 0 } = {}) {
  const style = /<w:pStyle[^>]*w:val="([^"]+)"/.exec(paragraphXml);
  const styleName = style ? style[1].toLowerCase() : '';
  const isList = /<w:numPr\b/.test(paragraphXml);
  const runs = Array.from(paragraphXml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g))
    .map((match) => renderRun(match[0], images))
    .join('');

  if (!runs.trim() && !/<w:drawing\b/.test(paragraphXml)) return '';

  const heading = /heading\s*([1-6])/.exec(styleName) || /^(?:заголовок)\s*([1-6])/.exec(styleName);
  const level = heading ? Number(heading[1]) : 0;

  if (level >= 1 && level <= 6) {
    return `<h${level}>${runs}</h${level}>`;
  }

  if (isList) {
    return `<li>${runs}</li>`;
  }

  return `<p>${runs}</p>`;
}

function renderTable(tableXml, images, warnings) {
  const rows = Array.from(tableXml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g));
  let html = '<table class="docx-table">';

  for (const row of rows) {
    html += '<tr>';
    const cells = Array.from(row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g));

    for (const cell of cells) {
      const paragraphs = Array.from(cell[0].matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g))
        .map((match) => renderParagraph(match[0], images))
        .join('');
      html += `<td>${paragraphs || '&nbsp;'}</td>`;
    }

    html += '</tr>';
  }

  html += '</table>';

  if (rows.length > 200) warnings.push('Таблица большая: отображены все строки, но проверьте читаемость');
  return html;
}

export function docxToHtml(buffer) {
  const documentXml = readZipEntry(buffer, 'word/document.xml');
  if (!documentXml) {
    throw Object.assign(new Error('Файл не похож на документ Word (нет word/document.xml)'), { code: 'DOCX_INVALID' });
  }

  if (documentXml.length > MAX_XML_BYTES) {
    throw Object.assign(new Error('Документ слишком большой для просмотра в браузере'), { code: 'DOCX_TOO_LARGE' });
  }

  const xml = documentXml.toString('utf8');
  const relations = readRelations(buffer);
  const warnings = [];
  const images = collectImages(buffer, relations, warnings);

  // Содержимое основного документа: всё, что внутри <w:body>.
  const bodyMatch = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;

  // Идём по документу в порядке следования: таблицы и абзацы.
  const blocks = [];
  const tokenRegex = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:sectPr[\s\S]*?<\/w:sectPr>/g;
  let match;

  while ((match = tokenRegex.exec(body)) !== null) {
    const chunk = match[0];
    if (chunk.startsWith('<w:tbl')) {
      blocks.push({ type: 'table', html: renderTable(chunk, images, warnings) });
    } else if (chunk.startsWith('<w:p')) {
      blocks.push({ type: 'paragraph', html: renderParagraph(chunk, images), list: /<w:numPr\b/.test(chunk) });
    }
  }

  // Объединяем соседние элементы списка в <ul>.
  const htmlParts = [];
  let listOpen = false;

  for (const block of blocks) {
    if (!block.html) continue;

    if (block.list) {
      if (!listOpen) {
        htmlParts.push('<ul class="docx-list">');
        listOpen = true;
      }
      htmlParts.push(block.html);
      continue;
    }

    if (listOpen) {
      htmlParts.push('</ul>');
      listOpen = false;
    }

    htmlParts.push(block.html);
  }

  if (listOpen) htmlParts.push('</ul>');

  // Колонтитулы и примечания не поддерживаются — предупреждаем честно.
  if (/<w:footnoteReference\b/.test(xml)) warnings.push('Сноски в предпросмотре не отображаются');
  if (/<w:object\b|<w:pict\b/.test(xml)) warnings.push('Встроенные OLE-объекты не отображаются');
  if (/<m:oMath\b|<m:oMathPara\b/.test(xml)) warnings.push('Формулы не отображаются');
  if (/<w:drawing\b/.test(xml) && images.size === 0) warnings.push('Изображения не извлечены');

  let html = htmlParts.join('') || '<p class="muted">Документ не содержит текста для отображения.</p>';

  if (html.length > MAX_HTML_CHARS) {
    html = html.slice(0, MAX_HTML_CHARS) + '<p class="muted">Документ сокращён для просмотра.</p>';
    warnings.push('Документ сокращён из-за размера');
  }

  return { html, warnings };
}

export default docxToHtml;
