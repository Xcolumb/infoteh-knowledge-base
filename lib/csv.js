// Минимальный разбор CSV (RFC 4180) без внешних зависимостей.
// Поддерживает кавычки, экранирование "" и переводы строк внутри полей.
export function parseCsv(text, { delimiter } = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const separator = delimiter || detectDelimiter(source);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === separator) {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((line) => line.some((value) => String(value).trim() !== ''));
}

function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/).find((line) => line.trim()) || '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons >= commas ? ';' : ',';
}

export function toObjects(rows, { headerAliases = {} } = {}) {
  if (!rows.length) return [];

  const header = rows[0].map((value) => String(value).trim().toLowerCase());
  const objects = [];

  for (const line of rows.slice(1)) {
    const object = {};
    header.forEach((key, index) => {
      const normalized = headerAliases[key] || key;
      object[normalized] = String(line[index] ?? '').trim();
    });
    objects.push(object);
  }

  return objects;
}

export default parseCsv;
