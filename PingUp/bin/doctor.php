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
    echo 'Diagnostics never print passwords, invite values or TURN credentials.' . PHP_EOL;
} catch (Throwable $error) {
    echo '[FAIL] Runtime initialization: ' . get_class($error) . PHP_EOL;
    exit(1);
}
exit($failed ? 1 : 0);
