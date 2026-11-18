import session from 'express-session';

// Хранилище сессий в SQLite: сессии переживают перезапуск сервера
// и не теряются при работе нескольких экземпляров приложения через одну БД.
export class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs = 8 * 60 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;

    this.stmt = {
      get: db.prepare('SELECT "sess", "expires" FROM "Сессия" WHERE "sid" = ?'),
      set: db.prepare('INSERT INTO "Сессия" ("sid", "sess", "expires") VALUES (?, ?, ?) ON CONFLICT("sid") DO UPDATE SET "sess" = excluded."sess", "expires" = excluded."expires"'),
      destroy: db.prepare('DELETE FROM "Сессия" WHERE "sid" = ?'),
      touch: db.prepare('UPDATE "Сессия" SET "expires" = ? WHERE "sid" = ?'),
      cleanup: db.prepare('DELETE FROM "Сессия" WHERE "expires" < ?')
    };

    const timer = setInterval(() => {
      try {
        this.stmt.cleanup.run(Date.now());
      } catch {
        // Игнорируем: очистка повторится на следующем тике.
      }
    }, 10 * 60 * 1000);
    timer.unref?.();
  }

  expiryOf(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    const time = expires ? new Date(expires).getTime() : Date.now() + this.ttlMs;
    return Number.isFinite(time) ? time : Date.now() + this.ttlMs;
  }

  get(sid, callback) {
    try {
      const row = this.stmt.get.get(sid);
      if (!row) return callback(null, null);

      if (row.expires < Date.now()) {
        this.stmt.destroy.run(sid);
        return callback(null, null);
      }

      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      this.stmt.set.run(sid, JSON.stringify(sess), this.expiryOf(sess));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      this.stmt.destroy.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback) {
    try {
      this.stmt.touch.run(this.expiryOf(sess), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

export default SqliteSessionStore;
