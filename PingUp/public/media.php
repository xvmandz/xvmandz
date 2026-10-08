<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header("Content-Security-Policy: default-src 'none'; sandbox");

try {
    if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD'], true)) {
        throw new ApiError('method_not_allowed', 405);
    }
    startSession();
    $user = currentUser();
    $id = intValue($_GET['id'] ?? null);
    $file = query('SELECT * FROM files WHERE id=?', [$id])->fetch();
    if (!$file) {
        throw new ApiError('file_not_found', 404);
    }
    $isAvatar = (bool)query("SELECT 1 FROM users WHERE avatar_file_id=? UNION ALL SELECT 1 FROM conversations c WHERE c.avatar_file_id=? AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id=?)) LIMIT 1", [$id,$id,$user['id']])->fetchColumn();
    $hasMembership = (bool)query('SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE m.file_id=? AND cm.user_id=? AND m.deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id) LIMIT 1', [$id, $user['id']])->fetchColumn();
    if ((int)$file['owner_id'] !== (int)$user['id'] && !$isAvatar && !$hasMembership) {
        throw new ApiError('file_not_found', 404);
    }
    $path = config()['upload_dir'] . '/' . $file['disk_name'];
    if (!is_file($path)) {
        throw new ApiError('file_not_found', 404);
    }
    session_write_close();
    $inline = str_starts_with($file['mime'], 'image/') || str_starts_with($file['mime'], 'audio/');
    $fallback = preg_replace('/[^a-zA-Z0-9._-]/', '_', $file['original_name']);
    header('Content-Type: ' . $file['mime']);
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . $fallback . '"; filename*=UTF-8\'\'' . rawurlencode($file['original_name']));
    header('Cache-Control: private, max-age=300');
    header('Accept-Ranges: bytes');
    $size = (int)$file['size'];
    $start = 0;
    $end = $size - 1;
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if ($range !== '') {
        if (!preg_match('/^bytes=(\d*)-(\d*)$/', $range, $match) || ($match[1] === '' && $match[2] === '')) {
            header('Content-Range: bytes */' . $size);
            throw new ApiError('invalid_range', 416);
        }
        if ($match[1] === '') {
            $suffix = (int)$match[2];
            $start = max(0, $size - $suffix);
        } else {
            $start = (int)$match[1];
            $end = $match[2] === '' ? $end : min($end, (int)$match[2]);
        }
        if ($start >= $size || $start > $end || (isset($suffix) && $suffix === 0)) {
            header('Content-Range: bytes */' . $size);
            throw new ApiError('invalid_range', 416);
        }
        http_response_code(206);
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
    }
    header('Content-Length: ' . ($end - $start + 1));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
        exit;
    }
    $handle = fopen($path, 'rb');
    fseek($handle, $start);
    $remaining = $end - $start + 1;
    while ($remaining > 0 && !feof($handle)) {
        $chunk = fread($handle, min(65536, $remaining));
        if ($chunk === false) {
            break;
        }
        echo $chunk;
        $remaining -= strlen($chunk);
    }
    fclose($handle);
} catch (ApiError $error) {
    http_response_code($error->status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header_remove('Content-Disposition');
    echo json_encode(['ok' => false, 'error' => ['code' => $error->errorCode, 'message' => $error->getMessage()]]);
} catch (Throwable $error) {
    error_log('PingUp media: ' . $error->getMessage());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => ['code' => 'internal_error', 'message' => 'internal_error']]);
}
