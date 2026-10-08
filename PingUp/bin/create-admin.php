#!/usr/bin/env php
<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

try {
    $options = getopt('', ['username:', 'name:']);
    $username = usernameValue($options['username'] ?? '');
    $name = textValue($options['name'] ?? 'PingUp Administration', 60, 1);
    fwrite(STDERR, "Admin password (10–128 bytes; enter via stdin, never as a CLI argument):\n");
    $password = passwordValue(rtrim((string)fgets(STDIN), "\r\n"));
    $hash = passwordHash($password);
    transaction(function () use ($username, $name, $hash): void {
        if (query('SELECT id FROM users WHERE username=?', [$username])->fetchColumn()) {
            throw new RuntimeException('Username already exists. CLI will not overwrite accounts.');
        }
        $id=insertId("INSERT INTO users(username,name,password_hash,role,last_seen,created_at) VALUES(?,?,?,'admin',?,?)", [$username, $name, $hash, time() - 91, time()]);
        savedConversation($id);
    });
    fwrite(STDOUT, "Verified administrator created: @" . $username . "\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'Cannot create administrator: ' . $error->getMessage() . "\n");
    exit(1);
}
