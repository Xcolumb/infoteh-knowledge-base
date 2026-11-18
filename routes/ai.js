import express from 'express';
import { ok } from '../lib/middleware.js';
import { describeAi, createAiProvider } from '../lib/ai/provider.js';
import { asyncHandler } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';

export function createAiRouter({ db }) {
  const router = express.Router();
  const provider = createAiProvider();

  router.get('/ai/status', (req, res) => {
    ok(res, { data: describeAi() });
  });

  // Заготовка вызова модели. Пока провайдер отключён, возвращается понятная ошибка.
  const handler = asyncHandler(async (req, res) => {
    writeAudit(db, {
      user: req.user,
      action: 'Запрос к ИИ (отклонён: провайдер не подключён)',
      entity: 'ai',
      result: 'failed',
      ip: req.ip
    });

    await provider.complete({ prompt: req.body.prompt });
    ok(res, {});
  });

  router.post('/ai/complete', handler);
  router.post('/ai/search', handler);
  router.post('/ai/summarize', handler);

  return router;
}

export default createAiRouter;
