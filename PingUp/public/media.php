<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';
require dirname(__DIR__) . '/src/actions.php';

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
    if (!mediaAccessible($file, $user)) {
        throw new ApiError('file_not_found', 404);
    }
    $path = config()['upload_dir'] . '/' . $file['disk_name'];
    if (!is_file($path)) {
        throw new ApiError('file_not_found', 404);
    }
    session_write_close();
    $inline = str_starts_with($file['mime'], 'image/') || str_starts_with($file['mime'], 'audio/') || str_starts_with($file['mime'], 'video/');
    // PDFs open inline only on explicit request (preview); browsers' viewers cannot run in a CSP sandbox.
    if ($file['mime'] === 'application/pdf' && ($_GET['preview'] ?? '') === '1') {
        $inline = true;
        header("Content-Security-Policy: default-src 'none'; frame-ancestors 'self'");
    }
    if (($_GET['download'] ?? '') === '1') $inline = false;
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
    header("Content-Security-Policy: default-src 'none'; sandbox");
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


/** Every route that legitimately exposes a file to this user; anything else is indistinguishable from a missing file. */
function mediaAccessible(array $file, array $user): bool
{
    $id = (int)$file['id'];
    $userId = (int)$user['id'];
    if ((int)$file['owner_id'] === $userId) return true;
    if ($file['purpose'] === 'feedback') {
        return $user['role'] === 'admin' || (bool)query('SELECT 1 FROM feedback_files ff JOIN feedback_tickets t ON t.id=ff.ticket_id WHERE ff.file_id=? AND t.user_id=?', [$id, $userId])->fetchColumn();
    }
    foreach (query('SELECT id FROM users WHERE avatar_file_id=?', [$id])->fetchAll(PDO::FETCH_COLUMN) as $ownerId) {
        if (privacyAllows((int)$ownerId, $userId, 'avatar')) return true;
    }
    if (query("SELECT 1 FROM conversations c WHERE (c.avatar_file_id=? OR c.cover_file_id=?) AND (c.visibility='public' OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id=?)) LIMIT 1", [$id, $id, $userId])->fetchColumn()) return true;
    if (query('SELECT 1 FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE s.file_id=? AND (p.system OR p.owner_id=? OR EXISTS(SELECT 1 FROM user_sticker_packs u WHERE u.pack_id=p.id AND u.user_id=?) OR EXISTS(SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE m.sticker_id=s.id AND cm.user_id=? AND m.deleted=0)) LIMIT 1', [$id, $userId, $userId, $userId])->fetchColumn()) return true;
    return (bool)query('SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE (m.file_id=? OR EXISTS(SELECT 1 FROM message_files mf WHERE mf.message_id=m.id AND mf.file_id=?)) AND cm.user_id=? AND m.deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id) LIMIT 1', [$id, $id, $userId])->fetchColumn();
}
