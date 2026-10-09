<?php
// Copy to config.local.php and replace the example values on your host.
return [
    // Credentials stay outside public/. Environment variables are also supported.
    'database_dsn' => 'pgsql:host=127.0.0.1;port=5432;dbname=pingup;sslmode=prefer',
    'database_user' => 'pingup',
    'database_password' => 'REPLACE_WITH_DATABASE_PASSWORD',
    'secure_cookies' => true,
    'registration_enabled' => true,
    'invite_code' => 'REPLACE_WITH_A_PRIVATE_INVITE_CODE',
    'max_users' => 5,
    'app_origin' => 'https://app.pingup.cc',
    // Empty for root deployments; '/pingup' for a subdirectory.
    'app_url' => '',
    // VAPID keys are generated with bin/vapid.php in private storage. Never put them in public/.
    'vapid_subject' => 'mailto:YOUR_REAL_CONTACT_EMAIL',
    // Per-file upload limits (bytes): 50 MB regular, 200 MB PingUp Premium.
    'max_upload_bytes' => 50 * 1024 * 1024,
    'premium_upload_bytes' => 200 * 1024 * 1024,
    // SMTP for e-mail verification, recovery and security notices. bin/mail-worker.php delivers the queue.
    'smtp_host' => 'smtp.example.com',
    'smtp_port' => 587,
    'smtp_secure' => 'tls', // tls = STARTTLS, ssl = implicit TLS (465)
    'smtp_user' => 'pingup@example.com',
    'smtp_password' => 'REPLACE_WITH_SMTP_PASSWORD',
    'mail_from' => 'no-reply@example.com',
    'mail_from_name' => 'PingUp',
    'ice_servers' => [
        ['urls' => 'stun:stun.l.google.com:19302'],
        // Add your own TURN relay for calls across restrictive networks:
        // ['urls' => 'turns:turn.example.com:5349', 'username' => 'beta', 'credential' => 'HOST_LOCAL_TURN_CREDENTIAL'],
    ],
];
