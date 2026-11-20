import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { setup, createClient } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const newSecret = () => 'T9' + randomBytes(18).toString('hex');

function isolatedCli(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pto-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env, NODE_ENV: 'production', SESSION_SECRET: newSecret(), ALLOW_DEMO_ACCOUNTS: '1',
    DATABASE_PATH: path.join(dir, 'test.db'), LOG_PATH: path.join(dir, 'logs'),
    UPLOADS_PATH: path.join(dir, 'uploads'), BACKUP_PATH: path.join(dir, 'backups'),
    INIT_ADMIN_TAB: 'ROOT41', INIT_ADMIN_NAME: 'Первый администратор', INIT_ADMIN_PASSWORD: newSecret(),
    SEED_ADMIN_PASSWORD: newSecret(), SEED_SENIOR_PASSWORD: newSecret(),
    SEED_WORKER_PASSWORD: newSecret(), SEED_PTO_PASSWORD: newSecret()
  };
  function run(args, expected, overrides = {}) {
    const childEnv = { ...env, ...overrides };
    const result = spawnSync(process.execPath, args, { cwd: root, env: childEnv, encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    const logPath = path.join(env.LOG_PATH, 'app.log');
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    for (const [key, value] of Object.entries(childEnv)) {
      if (/^(INIT_ADMIN_PASSWORD|SEED_.*_PASSWORD)$/.test(key) && value.length >= 10) {
        assert.ok(!(output + log).includes(value), 'Вывод содержит секрет');
      }
    }
    assert.equal(result.status, expected, output);
    return output;
  }
  return { env, run };
}

test('PTO-07: production отклоняет все команды демонаполнения до создания файлов', (t) => {
  const { env, run } = isolatedCli(t);
  for (const script of ['seed.js', 'migrate-pto.js', 'generate-pdfs.js']) {
    assert.match(run([script, '--force'], 1), /в production запрещено/);
    assert.ok(!fs.existsSync(env.DATABASE_PATH));
    assert.ok(!fs.existsSync(env.UPLOADS_PATH));
  }
  run(['--input-type=module', '-e',
    "import config from './config.js'; if (config.allowDemoAccounts) process.exit(1)"], 0);
});

test('PTO-07: первоначальный администратор создаётся один раз, существующие данные сохраняются', async (t) => {
  const { env, run } = isolatedCli(t);
  run(['scripts/migrate.js'], 0);
  const init = ['scripts/init-admin.js'];
  for (const value of ['', 'short', 'Ж'.repeat(36) + '9']) {
    run(init, 1, { INIT_ADMIN_PASSWORD: value });
  }
  run(init, 0);
  const db = new Database(env.DATABASE_PATH);
  try {
    const row = () => db.prepare('SELECT * FROM Сотрудник').all();
    const saved = row();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].Демо, 0);
    assert.equal(saved[0].Должность, 'Администратор');
    assert.ok(bcrypt.compareSync(env.INIT_ADMIN_PASSWORD, saved[0].Пароль));
    db.prepare('INSERT INTO Объект (Название, updated_at) VALUES (?, CURRENT_TIMESTAMP)').run('Сохранить');
    db.prepare('INSERT INTO Доступ_объект VALUES (?, ?)').run(saved[0].ID_сотрудника, 1);
    run(init, 1, { INIT_ADMIN_TAB: 'OTHER', INIT_ADMIN_PASSWORD: newSecret() });
    run(['seed.js', '--force'], 1, { NODE_ENV: 'development' });
    run(['migrate-pto.js'], 1, { NODE_ENV: 'development' });
    assert.deepEqual(row(), saved);
    assert.equal(db.prepare('SELECT count(*) AS n FROM Доступ_объект').get().n, 1);
  } finally { db.close(); }

  const ctx = await setup({ db: new Database(env.DATABASE_PATH), seed: false });
  try {
    assert.equal((await ctx.client.login(env.INIT_ADMIN_TAB, env.INIT_ADMIN_PASSWORD)).status, 200);
    assert.equal((await ctx.client.request('GET', '/api/sotrudniki')).status, 200);
  } finally { await ctx.close(); }
});

test('PTO-07: оба наполнителя маркируют демозаписи, запрет действует на вход и открытые сессии', async (t) => {
  const { env, run } = isolatedCli(t);
  const dev = { NODE_ENV: 'development' };
  run(['seed.js'], 0, dev);
  run(['migrate-pto.js'], 0, dev);
  const db = new Database(env.DATABASE_PATH);
  const rows = db.prepare('SELECT Демо AS demo FROM Сотрудник').all();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.demo === 1));
  const ctx = await setup({ db, seed: false });
  const config = (await import('../config.js')).default;
  try {
    const accounts = [
      ['ADM002', env.SEED_ADMIN_PASSWORD], ['SM002', env.SEED_SENIOR_PASSWORD],
      ['M002', env.SEED_WORKER_PASSWORD], ['PTO01', env.SEED_PTO_PASSWORD]
    ];
    assert.equal((await ctx.client.login(...accounts[0])).status, 200);
    config.allowDemoAccounts = false;
    assert.equal((await ctx.client.request('GET', '/api/auth/session')).status, 401);
    for (const [tab, secret] of accounts) {
      assert.equal((await createClient(ctx.base).login(tab, secret)).status, 403);
    }
  } finally { await ctx.close(); }
});
