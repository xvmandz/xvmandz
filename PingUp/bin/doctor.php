#!/usr/bin/env php
<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$failed = false;
$check = static function (string $label, bool $ok) use (&$failed): void {
    echo ($ok ? '[OK] ' : '[FAIL] ') . $label . PHP_EOL;
    $failed = $failed || !$ok;
};
$check('PHP 8.2+', PHP_VERSION_ID >= 80200);
foreach (['pdo_pgsql', 'fileinfo', 'mbstring', 'session', 'json', 'openssl', 'curl'] as $module) {
    $check('Extension ' . $module, extension_loaded($module));
}
if ($failed) { exit(1); }
try {
    require dirname(__DIR__) . '/src/bootstrap.php';
    $cfg = config();
    $check('Private storage outside public/', true);
    $check('Storage writable', is_writable($cfg['storage_path']) && is_writable($cfg['upload_dir']) && is_writable($cfg['session_dir']));
    $check('PostgreSQL schema '.PINGUP_SCHEMA_VERSION, (int)db()->query('SELECT MAX(version) FROM schema_migrations')->fetchColumn() === PINGUP_SCHEMA_VERSION);
    $check('Secure cookies configured (required on HTTPS production)', (bool)$cfg['secure_cookies']);
    if (!$cfg['app_origin']) { echo '[NOTICE] Set app_origin to the HTTPS origin on production.' . PHP_EOL; }
    if ($cfg['registration_enabled'] && $cfg['invite_code'] === '') { echo '[NOTICE] Registration has no invite code. Configure a private code for five testers.' . PHP_EOL; }
    $check('Public entrypoints present', is_file(dirname(__DIR__) . '/public/index.php') && is_file(dirname(__DIR__) . '/public/api.php') && is_file(dirname(__DIR__) . '/public/media.php'));
    $check('Web Push dependency installed', is_file(dirname(__DIR__).'/vendor/autoload.php'));
    echo '[INFO] Push configured: '.(pushAvailable()?'yes':'no (see UPGRADE.md)').PHP_EOL;
    require_once dirname(__DIR__) . '/src/actions.php';
    // Uploads arrive in chunks of UPLOAD_CHUNK_BYTES; PHP must accept one chunk plus multipart overhead.
    $bytes = static function (string $value): int { $n = (int)$value; return match (strtolower(substr(trim($value), -1))) { 'g' => $n * 1073741824, 'm' => $n * 1048576, 'k' => $n * 1024, default => $n }; };
    $check('upload_max_filesize >= 9M (chunked uploads)', $bytes((string)ini_get('upload_max_filesize')) >= 9 * 1048576);
    $check('post_max_size >= 10M (chunked uploads)', $bytes((string)ini_get('post_max_size')) >= 10 * 1048576);
    echo '[INFO] File limits: '.round(($cfg['max_upload_bytes'] ?? 0) / 1048576).' MB, Premium '.round(max($cfg['max_upload_bytes'] ?? 0, $cfg['premium_upload_bytes'] ?? 0) / 1048576).' MB per file.' . PHP_EOL;
    if (!extension_loaded('zip')) echo '[NOTICE] PHP zip extension missing: DOCX/XLSX/PPTX/ODT/ODS uploads are checked by ZIP signature only.' . PHP_EOL;
    $check('Built-in sticker assets present', count(glob(dirname(__DIR__) . '/public/assets/stickers/*.svg')) >= 12);
    echo '[INFO] SMTP configured: '.(smtpConfigured() ? 'yes' : 'no — e-mail verification/recovery codes stay queued (see UPGRADE.md)').PHP_EOL;
    $queued = (int)query("SELECT COUNT(*) FROM email_outbox WHERE status IN ('queued','sending')")->fetchColumn();
    $failedMail = (int)query("SELECT COUNT(*) FROM email_outbox WHERE status='failed'")->fetchColumn();
    echo '[INFO] Mail queue: '.$queued.' pending, '.$failedMail.' failed.' . PHP_EOL;
    $due = (int)query("SELECT COUNT(*) FROM scheduled_messages WHERE status='scheduled' AND send_at<?", [time() - 600])->fetchColumn();
    if ($due) echo '[NOTICE] '.$due.' scheduled messages are overdue by 10+ minutes: run bin/cleanup.php from cron (see UPGRADE.md).' . PHP_EOL;
    $admins = (int)query("SELECT COUNT(*) FROM users WHERE role='admin'")->fetchColumn();
    if (!$admins) echo '[NOTICE] No administrator: feedback and Premium management need one (bin/create-admin.php).' . PHP_EOL;
    echo 'Diagnostics never print passwords, invite values, SMTP or TURN credentials.' . PHP_EOL;
} catch (Throwable $error) {
    echo '[FAIL] Runtime initialization: ' . get_class($error) . PHP_EOL;
    exit(1);
}
exit($failed ? 1 : 0);
