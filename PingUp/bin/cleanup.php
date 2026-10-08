#!/usr/bin/env php
<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
try {
    $removed = transaction(function (): int {
        // Uploaded drafts remain available for a day. Messages and profile avatars retain files.
        $files = query('SELECT f.* FROM files f WHERE f.created_at<? AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.file_id=f.id AND m.deleted=0) AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_file_id=f.id) AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.avatar_file_id=f.id)', [time() - 86400])->fetchAll();
        foreach ($files as $file) {
            $path = config()['upload_dir'] . '/' . $file['disk_name'];
            if (!is_file($path) || unlink($path)) {
                query('DELETE FROM files WHERE id=?', [$file['id']]);
            }
        }
        query('DELETE FROM rate_limits WHERE expires_at<?', [time()]);
        query('DELETE FROM typing WHERE expires_at<?', [time()]);
        query('DELETE FROM push_subscriptions WHERE expires_at<?',[time()]);
        query('DELETE FROM notification_events WHERE created_at<?',[time()-30*86400]);
        return count($files);
    });
    db()->exec('ANALYZE');
    fwrite(STDOUT, 'Cleanup processed ' . $removed . " orphaned uploads.\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'Cleanup failed: ' . $error->getMessage() . "\n");
    exit(1);
}
