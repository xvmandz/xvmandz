# Изменения PingUp 2.1.0 относительно 2.0.0-beta.1

Схема БД 4 → 5 (только добавления). Фронтенд переработан с приоритетом мобильной версии. Предыдущая версия сохраняется в отдельном архиве; обновление — [UPGRADE.md](UPGRADE.md).

## Добавлены

- `update.sh` — автоматическое обновление 2.0 → 2.1 с резервной копией, проверками и откатом (`--rollback`)
- `database/migrations/005_messenger_2_1.sql` — схема 5
- `src/Privacy.php` — приватность, контакты, блокировки
- `src/Premium.php` — подписки Premium, аудит администратора, лимиты загрузки
- `src/Messages.php` — отправка (альбомы, стикеры, опросы, комментарии), отложенные сообщения, реакции, избранное, опросы, стикеры
- `src/Search.php` — глобальный поиск
- `src/Mail.php` — e-mail, коды, восстановление доступа, очередь писем, SMTP-клиент
- `src/Feedback.php` — центр обратной связи
- `src/Uploads.php` — форматы, лимиты, загрузка частями
- `bin/mail-worker.php` — отправка очереди писем
- `public/ui.js` — слои истории («Назад»), bottom sheet, меню, жесты, просмотрщик медиа, аудиоплеер, безопасное форматирование
- `public/chat.js` — экран чата
- `public/pages.js` — каналы, контакты, звонки, поиск, профили, управление сообществами, комментарии
- `public/settings.js` — настройки, приватность, оформление, Premium, e-mail, папки, стикеры, обратная связь, администрирование
- `public/app.css` — новая дизайн-система (темы, Premium-темы, фоны, оформление каналов)
- `public/assets/stickers/*.svg` — собственный набор стикеров PingUp (12)
- `deploy/pingup-mail.service`, `deploy/pingup.cron`, `deploy/php-fpm-pingup.ini`
- `tests/integration_21.py`, `tests/messenger21-browser.cjs`, `tests/upgrade-postgresql.php`

## Изменены

- `README.md`, `UPGRADE.md`, `TEST-RESULTS.md`, `NOTIFICATIONS-CALLS.md`, `CHANGED-FILES.md`, `VERSION`, `SHA256SUMS`
- `bin/migrate.php` (нумерованные миграции), `bin/doctor.php`, `bin/cleanup.php`, `bin/import-sqlite.php` (импорт в схему ≥ 4)
- `config.php`, `config.local.example.php` (лимиты 50/200 МБ, SMTP)
- `deploy/nginx.conf` (`client_max_body_size 20m`)
- `public/api.php`, `public/media.php`, `public/index.php`, `public/offline.html`, `public/sw.js`, `public/app.js`, `public/experience.js`, `public/locales/{uk,ru,en}.json`
- `src/bootstrap.php`, `src/actions.php`, `src/Channels.php`, `src/Notifications.php`, `src/Calls.php`
- `tests/browser-smoke.cjs`, `tests/update-browser.cjs`, `tests/experience-browser.cjs`, `tests/outbox-browser.cjs`, `tests/pwa-browser.cjs`, `tests/pwa-update.cjs`, `tests/sounds-browser.cjs`, `tests/calls-browser.cjs`, `tests/notifications.php`, `tests/performance.php`

## Удалены

- `public/styles.css`, `public/experience.css`, `public/motion.css` — заменены `public/app.css`

## Исправлено попутно

- HTTP 500 в поиске людей/сообщений/каналов на PHP 8.3: `ESCAPE '\'` ломал разбор плейсхолдеров PDO (версия 2.0 проверялась только на PHP 8.4).
- Список «контактов» в bootstrap раньше раскрывал первых 100 пользователей сервера; теперь это только подтверждённые контакты.
- Участники канала больше не передаются обычным подписчикам (видны только владелец и администраторы).

`SHA256SUMS` создан заново для содержимого архива. vendor/ — прежние зависимости composer.lock. Архив не содержит config.local.php, данных storage, паролей, VAPID-ключей и тестовых баз.
