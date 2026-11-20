import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { assertAdmin } from '../lib/permissions.js';
import { badRequest, notFound } from '../lib/errors.js';
import { ok } from '../lib/middleware.js';

// Имена генерирует сервер. Галерея не принимает пути к существующим файлам ПТО.
const photoName = /^\d{13}-[0-9a-f-]{36}\.(jpg|png)$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function imageExtension(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(pngSignature)
      && bytes.toString('ascii', 12, 16) === 'IHDR'
      && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') return 'png';
  if (bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes[2] === 0xff
      && bytes.includes(Buffer.from([0xff, 0xd9]), 3)) return 'jpg';
  throw badRequest('Выберите фотографию в формате JPEG или PNG');
}

export function createCompanyPhotosRouter(cfg) {
  const router = express.Router();
  const directory = path.join(cfg.uploadsPath, 'company-photos');
  const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fields: 0, fileSize: cfg.maxUploadBytes } });

  router.get('/', async (req, res) => {
    let photos = [];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      photos = entries.filter(entry => entry.isFile() && photoName.test(entry.name)).map(entry => entry.name).sort().reverse();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    res.set('Cache-Control', 'private, no-store');
    ok(res, { photos });
  });

  router.get('/:name', (req, res, next) => {
    if (!photoName.test(req.params.name)) throw notFound();
    res.sendFile(req.params.name, { root: directory, headers: { 'Cache-Control': 'private, no-store' } }, error => {
      if (error) next(error.code === 'ENOENT' ? notFound() : error);
    });
  });

  router.post('/', (req, res, next) => { assertAdmin(req.user); next(); }, upload.single('photo'), async (req, res) => {
    if (!req.file) throw badRequest('Выберите фотографию');
    const extension = imageExtension(req.file.buffer);
    const name = Date.now() + '-' + randomUUID() + '.' + extension;
    const temp = path.join(directory, name + '.tmp');
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temp, req.file.buffer, { flag: 'wx' });
      await rename(temp, path.join(directory, name));
    } finally {
      await rm(temp, { force: true });
    }
    ok(res, { name });
  });
  return router;
}
