import zlib from 'zlib';

// Минимальный ZIP-ридер для извлечения текста из DOCX/XLSX.
// Внешних зависимостей нет: используется только встроенный zlib.
export function readZipEntries(buffer) {
  let eocd = -1;
  const minStart = Math.max(0, buffer.length - 66_000);

  for (let i = buffer.length - 22; i >= minStart; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) throw new Error('ZIP: не найден конец центрального каталога');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let pointer = centralOffset;

  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    pointer += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, Math.min(dataStart + compressedSize, buffer.length));

    entries.set(name, { method, data });
  }

  return entries;
}

export function readZipEntry(buffer, name) {
  const entries = readZipEntries(buffer);
  const entry = entries.get(name);
  if (!entry) return null;

  if (entry.method === 0) return entry.data;
  if (entry.method === 8) return zlib.inflateRawSync(entry.data);

  throw new Error(`ZIP: неподдерживаемый метод сжатия ${entry.method}`);
}

export function listZipEntries(buffer) {
  return Array.from(readZipEntries(buffer).keys());
}

export default { readZipEntries, readZipEntry, listZipEntries };
