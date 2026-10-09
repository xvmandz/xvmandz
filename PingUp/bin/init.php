#!/usr/bin/env php
<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
try {
    db();
    fwrite(STDOUT, "PingUp database initialized. No accounts were seeded.\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'Initialization failed: ' . $error->getMessage() . "\n");
    exit(1);
}
