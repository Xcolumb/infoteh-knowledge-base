import express from 'express';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import { asyncHandler } from '../lib/errors.js';
import { badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { ok, requireAuth } from '../lib/middleware.js';
import { csrfProtection, ensureCsrfToken, isLoginBlocked, recordLoginFailure, resetLoginAttempts, rotateCsrfToken } from '../lib/security.js';
import { password as validatePassword, text } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { sessionPermissions } from '../lib/permissions.js';

const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8.2mFVRCcL5F0m7Vj2T3w4W5n6Y7a8';

function publicUser(user) {
  return {
    id: user.id,
    tabNumber: user.tabNumber,
    fullName: user.fullName,
    role: user.role,
    demo: Boolean(user.demo)
  };
}

export function createAuthRouter({ db }) {
  const router = express.Router();

  router.post('/login', asyncHandler(async (req, res) => {
    const tabNumber = text(req.body.tabNumber, { field: 'Табельный номер', required: true, max: 40 });
    const rawPassword = String(req.body.password || '');

    if (!rawPassword) throw badRequest('Введите пароль');

    if (isLoginBlocked(req, tabNumber)) {
      return res.status(429).json({
        success: false,
        error: 'Слишком много неудачных попыток. Повторите вход через 15 минут.',
        code: 'LOGIN_BLOCKED'
      });
    }

    const employee = db.prepare(`
      SELECT "ID_сотрудника" as id, "Табельный_номер" as tabNumber, "ФИО" as fullName,
             "Должность" as role, "Пароль" as passwordHash, "Демо" as demo, "Заблокирован" as blocked
      FROM "Сотрудник" WHERE "Табельный_номер" = ?
    `).get(tabNumber);

    // Сравнение выполняется даже для несуществующего логина, чтобы не раскрывать
    // наличие табельного номера по времени ответа.
    const passwordMatches = await bcrypt.compare(rawPassword, employee ? employee.passwordHash : DUMMY_HASH);

    if (!employee || !passwordMatches) {
      recordLoginFailure(req, tabNumber);
      logger.warn('Неудачная попытка входа', { tabNumber, ip: req.ip });
      writeAudit(db, {
        action: 'Вход в систему',
        entity: 'auth',
        result: 'failed',
        ip: req.ip,
        details: { tabNumber }
      });
      return res.status(401).json({ success: false, error: 'Неверный табельный номер или пароль' });
    }

    if (employee.blocked) {
      recordLoginFailure(req, tabNumber);
      return res.status(403).json({ success: false, error: 'Учётная запись заблокирована администратором' });
    }

    if (employee.demo && !config.allowDemoAccounts) {
      return res.status(403).json({
        success: false,
        error: 'Демонстрационная учётная запись отключена в этой конфигурации'
      });
    }

    resetLoginAttempts(req, tabNumber);

    // Перегенерация идентификатора сессии защищает от фиксации сессии.
    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ success: false, error: 'Не удалось создать сессию' });

      req.session.userId = employee.id;
      req.session.role = employee.role;
      req.session.fullName = employee.fullName;
      const csrfToken = rotateCsrfToken(req);

      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ success: false, error: 'Не удалось сохранить сессию' });

        logger.info('Вход в систему', { employeeId: employee.id, role: employee.role });
        writeAudit(db, {
          user: { id: employee.id, fullName: employee.fullName },
          action: 'Вход в систему',
          entity: 'auth',
          entityId: employee.id,
          result: 'success',
          ip: req.ip
        });

        ok(res, {
          user: publicUser(employee),
          csrfToken,
          permissions: sessionPermissions(employee)
        });
      });
    });
  }));

  router.use(requireAuth(db), csrfProtection);

  router.post('/logout', (req, res) => {
    const user = req.session ? { id: req.session.userId, fullName: req.session.fullName } : null;

    if (!req.session) return ok(res, {});

    req.session.destroy((error) => {
      if (error) logger.warn('Ошибка завершения сессии', { error: error.message });
      res.clearCookie(config.sessionCookieName);
      if (user && user.id) {
        writeAudit(db, { user, action: 'Выход из системы', entity: 'auth', result: 'success', ip: req.ip });
      }
      ok(res, {});
    });
  });

  router.get('/session', (req, res) => {
    ok(res, {
      user: publicUser({ ...req.user, demo: req.user.demo }),
      csrfToken: ensureCsrfToken(req),
      permissions: sessionPermissions(req.user)
    });
  });

  router.post('/password', asyncHandler(async (req, res) => {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (!currentPassword) throw badRequest('Введите текущий пароль');

    const employee = db.prepare('SELECT "Пароль" as passwordHash, "Табельный_номер" as tabNumber FROM "Сотрудник" WHERE "ID_сотрудника" = ?').get(req.user.id);
    const matches = await bcrypt.compare(currentPassword, employee.passwordHash);

    if (!matches) throw forbidden('Текущий пароль указан неверно');

    const valid = validatePassword(newPassword, { tabNumber: employee.tabNumber });

    if (await bcrypt.compare(valid, employee.passwordHash)) {
      throw badRequest('Новый пароль должен отличаться от текущего');
    }

    const hash = await bcrypt.hash(valid, 10);
    db.prepare('UPDATE "Сотрудник" SET "Пароль" = ?, "Пароль_обновлён" = datetime(\'now\', \'localtime\') WHERE "ID_сотрудника" = ?')
      .run(hash, req.user.id);

    writeAudit(db, {
      user: req.user,
      action: 'Смена пароля',
      entity: 'employee',
      entityId: req.user.id,
      result: 'success',
      ip: req.ip
    });

    // После смены пароля сессия перегенерируется: старые вкладки потребуют повторного входа.
    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ success: false, error: 'Пароль изменён, но сессия не обновлена. Войдите заново.' });
      req.session.userId = req.user.id;
      req.session.role = req.user.role;
      req.session.fullName = req.user.fullName;
      const csrfToken = rotateCsrfToken(req);
      req.session.save(() => ok(res, { csrfToken, message: 'Пароль изменён' }));
    });
  }));

  return router;
}

export default createAuthRouter;
