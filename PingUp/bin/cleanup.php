#!/usr/bin/env php
<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';
require dirname(__DIR__) . '/src/actions.php';
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
// Run every few minutes from cron: publishes scheduled posts, expires uploads and removes orphaned files.
try {
    $published = publishDueScheduled(100);
    $partial = uploadsCleanup();
    $removed = transaction(function (): int {
        // Uploaded drafts remain available for a day. Files referenced anywhere are retained.
        $files = query('SELECT f.* FROM files f WHERE f.created_at<? AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.file_id=f.id AND m.deleted=0) AND NOT EXISTS(SELECT 1 FROM message_files mf WHERE mf.file_id=f.id) AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_file_id=f.id) AND NOT EXISTS(SELECT 1 FROM conversations c WHERE c.avatar_file_id=f.id OR c.cover_file_id=f.id) AND NOT EXISTS(SELECT 1 FROM feedback_files ff WHERE ff.file_id=f.id) AND NOT EXISTS(SELECT 1 FROM stickers s WHERE s.file_id=f.id) AND NOT EXISTS(SELECT 1 FROM scheduled_messages sm WHERE sm.status=\'scheduled\' AND ((sm.payload->>\'file_id\')::bigint=f.id OR sm.payload->\'file_ids\' @> to_jsonb(f.id)))', [time() - 86400])->fetchAll();
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
        query('DELETE FROM email_tokens WHERE expires_at<?',[time()-86400]);
        query("DELETE FROM scheduled_messages WHERE status IN ('sent','cancelled') AND created_at<?",[time()-30*86400]);
        return count($files);
    });
    db()->exec('ANALYZE');
    fwrite(STDOUT, 'Cleanup processed ' . $removed . ' orphaned uploads, ' . $partial . ' expired partial uploads, published ' . $published . " scheduled messages.\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'Cleanup failed: ' . $error->getMessage() . "\n");
    exit(1);
}
