<?php
// Do not put this project root inside your web server's document root.
declare(strict_types=1);
$env = static function (string $key, mixed $default = null): mixed {
    $value = getenv($key);
    return $value === false ? $default : $value;
};
$boolean = static fn (string $key, bool $default): bool => filter_var($env($key, $default ? '1' : '0'), FILTER_VALIDATE_BOOLEAN);
$storage = rtrim((string) $env('PINGUP_STORAGE_PATH', __DIR__ . '/storage'), '/');
$config = [
    'storage_path' => $storage,
    'database_dsn' => (string)$env('PINGUP_DATABASE_DSN', 'pgsql:host=127.0.0.1;port=5432;dbname=pingup;sslmode=prefer'),
    'database_user' => (string)$env('PINGUP_DATABASE_USER', 'pingup'),
    'database_password' => (string)$env('PINGUP_DATABASE_PASSWORD', ''),
    'upload_dir' => $storage . '/uploads',
    'session_dir' => $storage . '/sessions',
    'session_name' => 'pingup_session',
    // For localhost only, set PINGUP_SECURE_COOKIES=0. Production must use HTTPS.
    'secure_cookies' => $boolean('PINGUP_SECURE_COOKIES', true),
    'registration_enabled' => $boolean('PINGUP_REGISTRATION_ENABLED', true),
    // Set a private invite code before opening your beta.
    'invite_code' => (string) $env('PINGUP_INVITE_CODE', ''),
    'max_users' => max(0, (int) $env('PINGUP_MAX_USERS', 5)),
    // Per-file limits: 50 MB for everyone, 200 MB with PingUp Premium. Chunked uploads keep PHP/Nginx request bodies at 8 MB.
    'max_upload_bytes' => min(2048 * 1024 * 1024, max(1, (int) $env('PINGUP_MAX_UPLOAD_BYTES', 50 * 1024 * 1024))),
    'premium_upload_bytes' => min(2048 * 1024 * 1024, max(1, (int) $env('PINGUP_PREMIUM_UPLOAD_BYTES', 200 * 1024 * 1024))),
    // Outgoing mail (verification, recovery, security notices). Keep the password in config.local.php or the service environment.
    'smtp_host' => (string)$env('PINGUP_SMTP_HOST', ''),
    'smtp_port' => (int)$env('PINGUP_SMTP_PORT', 587),
    'smtp_secure' => (string)$env('PINGUP_SMTP_SECURE', 'tls'), // tls (STARTTLS), ssl (implicit TLS) or none (loopback relay only)
    'smtp_user' => (string)$env('PINGUP_SMTP_USER', ''),
    'smtp_password' => (string)$env('PINGUP_SMTP_PASSWORD', ''),
    'mail_from' => (string)$env('PINGUP_MAIL_FROM', ''),
    'mail_from_name' => (string)$env('PINGUP_MAIL_FROM_NAME', 'PingUp'),
    'app_origin' => (string) $env('PINGUP_APP_ORIGIN', ''),
    'app_url' => (string) $env('PINGUP_APP_URL', ''),
    'vapid_file' => $storage . '/vapid.json',
    'vapid_subject' => (string)$env('PINGUP_VAPID_SUBJECT', 'mailto:admin@pingup.cc'),
    'push_hosts' => ['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com', 'wns.windows.com'],
    'ice_servers' => [['urls' => 'stun:stun.l.google.com:19302']],
];
// Optional host-local settings, never shipped in release archives or stored in Git.
$local = __DIR__ . '/config.local.php';
if (is_file($local)) {
    $overrides = require $local;
    if (!is_array($overrides)) {
        throw new RuntimeException('config.local.php must return an array.');
    }
    $config = array_replace($config, $overrides);
}
return $config;
