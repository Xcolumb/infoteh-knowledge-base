# DEPLOYMENT_RU_VPS — размещение и эксплуатация на российском VPS

Инструкция для администратора. Описывает подготовку сервера, установку, HTTPS, автозапуск, резервное копирование, обновление и восстановление.
**Приложение на реальный сервер не разворачивалось.** Провайдер не выбирался: подойдёт любой российский VPS с Ubuntu 22.04/24.04 LTS.

---

## 0. Требования к серверу

| Параметр | Минимум для пилота (3–5 пользователей) | Рекомендуется при росте |
| --- | --- | --- |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 ГБ | 8 ГБ |
| Диск | 40 ГБ SSD | 100 ГБ SSD + отдельный диск под бэкапы |
| ОС | Ubuntu 22.04 LTS / 24.04 LTS | то же |
| Сеть | публичный IP, домен, доступ по SSH-ключу | + WAF/файрвол провайдера |

Оценка объёма: 1 документ ≈ 1–7 МБ; 1 000 документов ≈ 5–7 ГБ без учёта резервных копий.

---

## 1. Подготовка сервера

```bash
# от root или sudo
adduser infoteh
usermod -aG sudo infoteh

apt update && apt upgrade -y
apt install -y nginx certbot python3-certbot-nginx ufw curl unzip fail2ban

ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

SSH: только по ключам, вход root запрещён (`/etc/ssh/sshd_config`).

---

## 2. Установка Node.js

Проект зафиксирован на версии из `.nvmrc`. На момент проверки использовался **Node.js v26.13.0**. Для VPS рекомендуется **Node.js 24 LTS** (поддерживается, но требует пересборки нативного модуля).

```bash
# вариант через nvm (удобно переключать версию)
sudo -u infoteh -H bash -c '
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm alias default 24
'

sudo -u infoteh -H bash -c 'node -v && npm -v'
```

**Важно:** `better-sqlite3` — нативный модуль и привязан к версии Node (ABI). После установки/смены версии выполните:

```bash
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm rebuild better-sqlite3'
```

Если версия Node не совпадает с `.nvmrc`, зафиксируйте используемую версию в `.nvmrc` или в unit-файле.

---

## 3. Размещение приложения

```bash
sudo mkdir -p /opt/infoteh
sudo chown -R infoteh:infoteh /opt/infoteh

# копирование проекта (git clone или архив)
sudo -u infoteh -H bash -c 'cd /opt/infoteh && git clone <репозиторий> . && git checkout feature/pto-modernization'

sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm ci'
```

Создайте окружение:

```bash
sudo -u infoteh -H bash -c 'cd /opt/infoteh && cp .env.example .env && chmod 600 .env'
sudo -u infoteh -H bash -c 'cd /opt/infoteh && openssl rand -hex 32'
# полученное значение впишите в SESSION_SECRET
sudo -u infoteh -H nano /opt/infoteh/.env
```

Минимально необходимо в `.env`:

```ini
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
SESSION_SECRET=<64 hex-символа>
TRUST_PROXY=1
COOKIE_SECURE=1
ENABLE_HSTS=0        # включить после проверки HTTPS
ALLOW_DEMO_ACCOUNTS=0
DATABASE_PATH=infoteh.db
UPLOADS_PATH=uploads
BACKUP_PATH=backups
LOG_PATH=logs
```

Права:

```bash
sudo -u infoteh -H bash -c 'cd /opt/infoteh && mkdir -p uploads backups logs && chmod 700 backups logs'
```

База данных:

```bash
# первый запуск создаёт схему и применяет миграции
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm run migrate'
```

Если требуется демонстрационное наполнение (только для тестового стенда):

```bash
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm run seed'
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm run migrate-pto'
```

В production демо-учётные записи будут заблокированы (`ALLOW_DEMO_ACCOUNTS=0`).

---

## 4. systemd

```bash
sudo cp /opt/infoteh/deploy/infoteh.service /etc/systemd/system/infoteh.service
# проверьте User/WorkingDirectory и путь к node
sudo systemctl daemon-reload
sudo systemctl enable --now infoteh
sudo systemctl status infoteh
```

Проверка:

```bash
curl -I http://127.0.0.1:3001/
# ожидается HTTP/1.1 200 OK
```

Логи:

```bash
journalctl -u infoteh -f
tail -f /opt/infoteh/logs/app.log
```

---

## 5. Nginx и HTTPS

```bash
sudo cp /opt/infoteh/deploy/nginx.conf /etc/nginx/sites-available/infoteh
sudo ln -s /etc/nginx/sites-available/infoteh /etc/nginx/sites-enabled/infoteh
sudo nginx -t && sudo systemctl reload nginx
```

Замените `infoteh.example.ru` на ваш домен. Затем сертификат:

```bash
sudo certbot --nginx -d infoteh.example.ru
```

После подтверждения HTTPS включите HSTS в `.env` (`ENABLE_HSTS=1`) и перезапустите:

```bash
sudo systemctl restart infoteh
```

Проверки после настройки:

```bash
curl -I https://infoteh.example.ru/
# HSTS, X-Content-Type-Options, X-Frame-Options, CSP
curl -X POST https://infoteh.example.ru/api/auth/login -d '{}' -H 'content-type: application/json'
# 400/401, без 500
```

Cookie `infoteh.sid` должна иметь флаги `Secure; HttpOnly; SameSite=Lax`.

---

## 5.1. Поддержка старых форматов DOC/XLS (опционально)

Встроенный просмотр современных форматов (PDF, DOCX, XLSX, CSV, TXT, изображения) работает без дополнительных компонентов. Для просмотра устаревших `.doc`/`.xls` нужен LibreOffice:

```bash
# Ubuntu 22.04/24.04
apt install -y libreoffice-writer libreoffice-calc
# проверка
soffice --version
```

Если LibreOffice не установлен, система корректно сообщает «Предварительный просмотр этого формата недоступен» и предлагает скачать файл. Путь к бинарнику можно задать переменной `LIBREOFFICE_PATH` в `.env`.

---

## 6. Резервное копирование

Ежедневно (пример — 02:30):

```cron
30 2 * * * infoteh cd /opt/infoteh && /usr/bin/node scripts/backup.js >> logs/backup.log 2>&1
```

Пример в `deploy/backup.cron`. Проверка:

```bash
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm run backup'
```

Копии складываются в `backups/backup-<дата>`; внутри — `infoteh.db`, `uploads/`, `manifest.json` с SHA-256 и результатом `integrity_check`. Старые копии удаляются по `BACKUP_KEEP`.

Рекомендации:

- хранить копии **вне сервера** (другой диск/хранилище), иначе потеря сервера = потеря копий;
- проверять восстановление не реже раза в квартал;
- каталог `backups/` закрыть правами 700.

---

## 7. Обновление приложения

```bash
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm run backup'
sudo -u infoteh -H bash -c 'cd /opt/infoteh && git fetch && git checkout <тег/ветка>'
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm ci'
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm rebuild better-sqlite3'   # если менялась версия Node
sudo -u infoteh -H bash -c 'cd /opt/infoteh && npm run migrate'
sudo systemctl restart infoteh
curl -fsS https://infoteh.example.ru/ > /dev/null && echo OK
```

Миграции идемпотентны и выполняются в транзакциях; перед обновлением обязательна свежая копия.

---

## 8. Восстановление после сбоя

1. Остановить сервис: `sudo systemctl stop infoteh`.
2. Проверить копию: `node scripts/restore.js backups/backup-XXXX --force` (скрипт сам проверяет целостность и делает страховочную копию текущего состояния).
3. Запустить: `sudo systemctl start infoteh`.
4. Проверить вход, наличие документов, открытие файла.
5. Убедиться, что индекс поиска построен (в логе `Индекс поиска перестроен` при первом запуске).

При потере диска: развернуть сервер заново (разделы 1–5), восстановить последнюю копию.

---

## 9. Контроль эксплуатации

| Что | Как |
| --- | --- |
| Доступность | `systemctl status infoteh`, внешний мониторинг `https://.../` (200) |
| Ошибки | `logs/app.log` (JSON, поле `level: error`), `journalctl -u infoteh` |
| Свободное место | `df -h`, алерт при < 15 %; объём `uploads/` и `backups/` |
| Бэкапы | наличие свежей копии, лог `logs/backup.log` |
| Безопасность | обновления ОС/Node, `npm audit`, проверка учётных записей |

Пример logrotate (`/etc/logrotate.d/infoteh`):

```
/opt/infoteh/logs/*.log {
  daily
  rotate 30
  compress
  missingok
  notifempty
  copytruncate
}
```

---

## 10. Что остаётся сделать администратору (чек-лист)

- [ ] Создать VPS, пользователя, включить файрвол и SSH-ключи.
- [ ] Установить Node.js, зафиксировать версию, выполнить `npm rebuild better-sqlite3`.
- [ ] Скопировать проект, выполнить `npm ci`, создать `.env` (секрет ≥ 32 символов).
- [ ] Выполнить `npm run migrate`, проверить запуск.
- [ ] Настроить systemd и Nginx, получить сертификат, включить HSTS.
- [ ] Убедиться, что `ALLOW_DEMO_ACCOUNTS=0`, создать реальных пользователей, сменить пароли.
- [ ] Настроить ежедневный бэкап и проверить восстановление.
- [ ] Настроить мониторинг и logrotate.
- [ ] Провести приёмочные проверки из `TEST_REPORT.md` на реальном контуре.
- [ ] Подписать регламент доступа и обработки ПДн.
