# Изменения PingUp 2.0.0-beta.1 относительно 1.1.0-beta.1

Runtime переведён на PostgreSQL, SQLite оставлена только для источника импорта. Предыдущие версии сохранены отдельно.

## Изменены

- `.gitignore`
- `README.md`
- `TEST-RESULTS.md`
- `UPGRADE.md`
- `VERSION`
- `bin/cleanup.php`
- `bin/create-admin.php`
- `bin/doctor.php`
- `bin/migrate.php`
- `bin/push-worker.php`
- `config.local.example.php`
- `config.php`
- `deploy/nginx.conf`
- `public/api.php`
- `public/app.js`
- `public/experience.js`
- `public/index.php`
- `public/locales/en.json`
- `public/locales/ru.json`
- `public/locales/uk.json`
- `public/media.php`
- `public/sw.js`
- `src/Calls.php`
- `src/Notifications.php`
- `src/PushWorker.php`
- `src/actions.php`
- `src/bootstrap.php`
- `tests/notifications.php`
- `tests/pwa-update.cjs`

## Добавлены

- `NOTIFICATIONS-CALLS.md`
- `bin/import-sqlite.php`
- `database/postgresql.sql`
- `public/motion.css`
- `src/Channels.php`
- `tests/concurrency.php`
- `tests/concurrency.py`
- `tests/import-postgresql.py`
- `tests/performance.php`
- `tests/update-browser.cjs`

`CHANGED-FILES.md` и `SHA256SUMS` созданы заново. vendor/ сохраняет подготовленные зависимости composer.lock и лицензии. Архив не содержит config.local.php, данных storage, паролей, VAPID-ключей, тестовых баз и изображений проверок.
