<?php
declare(strict_types=1);

// Uploads: content sniffing per extension, per-purpose limits, direct and chunked transfer.

const UPLOAD_PURPOSES = ['file', 'avatar', 'voice', 'feedback', 'sticker'];
const UPLOAD_CHUNK_BYTES = 8 * 1048576;
const OFFICE_ZIP = ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'];

/** extension => [served MIME, accepted detected MIME types]. Executable and active formats (html, svg, js, php, exe) are absent on purpose. */
function uploadFormats(): array
{
    return [
        'jpg' => ['image/jpeg', ['image/jpeg']], 'jpeg' => ['image/jpeg', ['image/jpeg']], 'png' => ['image/png', ['image/png']],
        'gif' => ['image/gif', ['image/gif']], 'webp' => ['image/webp', ['image/webp']], 'avif' => ['image/avif', ['image/avif', 'image/heif', 'application/octet-stream']],
        'mp3' => ['audio/mpeg', ['audio/mpeg', 'audio/mp3', 'application/octet-stream']], 'wav' => ['audio/wav', ['audio/wav', 'audio/x-wav', 'audio/wave']],
        'ogg' => ['audio/ogg', ['audio/ogg', 'application/ogg', 'video/ogg']], 'oga' => ['audio/ogg', ['audio/ogg', 'application/ogg']],
        'm4a' => ['audio/mp4', ['audio/mp4', 'audio/x-m4a', 'video/mp4', 'audio/aac']], 'aac' => ['audio/aac', ['audio/aac', 'audio/x-aac', 'audio/x-hx-aac-adts', 'application/octet-stream']],
        'flac' => ['audio/flac', ['audio/flac', 'audio/x-flac']], 'webm' => ['video/webm', ['video/webm', 'audio/webm']],
        'mp4' => ['video/mp4', ['video/mp4', 'audio/mp4', 'application/mp4']], 'mov' => ['video/quicktime', ['video/quicktime', 'video/mp4']],
        'pdf' => ['application/pdf', ['application/pdf']],
        'doc' => ['application/msword', ['application/msword', 'application/vnd.ms-office', 'application/CDFV2', 'application/x-ole-storage']],
        'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', array_merge(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], OFFICE_ZIP)],
        'xls' => ['application/vnd.ms-excel', ['application/vnd.ms-excel', 'application/vnd.ms-office', 'application/CDFV2', 'application/x-ole-storage']],
        'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', array_merge(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], OFFICE_ZIP)],
        'ppt' => ['application/vnd.ms-powerpoint', ['application/vnd.ms-powerpoint', 'application/vnd.ms-office', 'application/CDFV2', 'application/x-ole-storage']],
        'pptx' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation', array_merge(['application/vnd.openxmlformats-officedocument.presentationml.presentation'], OFFICE_ZIP)],
        'odt' => ['application/vnd.oasis.opendocument.text', array_merge(['application/vnd.oasis.opendocument.text'], OFFICE_ZIP)],
        'ods' => ['application/vnd.oasis.opendocument.spreadsheet', array_merge(['application/vnd.oasis.opendocument.spreadsheet'], OFFICE_ZIP)],
        'txt' => ['text/plain', ['text/plain']], 'csv' => ['text/csv', ['text/plain', 'text/csv', 'application/csv']],
        'json' => ['application/json', ['application/json', 'text/plain']], 'xml' => ['application/xml', ['text/xml', 'application/xml', 'text/plain']],
        'md' => ['text/markdown', ['text/plain', 'text/markdown', 'text/x-markdown']],
        'zip' => ['application/zip', ['application/zip', 'application/x-zip-compressed']], 'rar' => ['application/vnd.rar', ['application/x-rar', 'application/vnd.rar', 'application/x-rar-compressed']],
        '7z' => ['application/x-7z-compressed', ['application/x-7z-compressed']], 'tar' => ['application/x-tar', ['application/x-tar']],
        'gz' => ['application/gzip', ['application/gzip', 'application/x-gzip']],
    ];
}

function uploadPurposeLimit(string $purpose, int $userId): int
{
    return match ($purpose) {
        'avatar' => 10 * 1048576,
        'sticker' => 512 * 1024,
        'feedback' => FEEDBACK_FILE_BYTES,
        default => uploadLimit($userId),
    };
}

function uploadName(mixed $name): string
{
    $name = preg_replace('/[\x00-\x1F\x7F\/\\\\]/u', '_', (string)$name);
    return textValue($name ?? '', 180, 1);
}

/** Validates a complete file on disk and registers it. The temporary file is moved or deleted. */
function registerUpload(string $tmpPath, string $name, string $purpose, array $user, bool $uploaded): array
{
    $userId = (int)$user['id'];
    if (!in_array($purpose, UPLOAD_PURPOSES, true)) throw new ApiError('file_type_forbidden', 415);
    clearstatcache(true, $tmpPath);
    $size = (int)filesize($tmpPath);
    $limit = uploadPurposeLimit($purpose, $userId);
    if ($size <= 0) throw new ApiError('upload_failed');
    if ($size > $limit) throw new ApiError($purpose === 'file' && !premiumActive($userId) && $size <= uploadLimit($userId, true) ? 'file_too_large_premium' : 'file_too_large', 413);
    $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $formats = uploadFormats();
    $detected = (new finfo(FILEINFO_MIME_TYPE))->file($tmpPath) ?: 'application/octet-stream';
    if (!isset($formats[$extension]) || !in_array($detected, $formats[$extension][1], true)) throw new ApiError('file_type_forbidden', 415);
    // Office Open XML / ODF are ZIP containers: require the matching marker so arbitrary archives cannot pose as documents.
    if (in_array($extension, ['docx', 'xlsx', 'pptx', 'odt', 'ods'], true) && !officeContainer($tmpPath, $extension)) throw new ApiError('file_type_forbidden', 415);
    if (in_array($extension, ['txt', 'csv', 'json', 'xml', 'md'], true) && !mb_check_encoding((string)file_get_contents($tmpPath, false, null, 0, 65536), 'UTF-8') && $detected !== 'text/plain') throw new ApiError('file_type_forbidden', 415);
    $mime = $formats[$extension][0];
    $image = str_starts_with($mime, 'image/');
    if ($image) {
        $info = @getimagesize($tmpPath);
        if (!$info || $info[0] > 8192 || $info[1] > 8192 || $info[0] * $info[1] > 40000000) throw new ApiError('file_type_forbidden', 415);
        if ($purpose === 'sticker' && ($info[0] > 512 || $info[1] > 512 || !in_array($mime, ['image/png', 'image/webp', 'image/gif'], true))) throw new ApiError('invalid_sticker', 415);
    }
    if (in_array($purpose, ['avatar', 'sticker'], true) && !$image) throw new ApiError('invalid_avatar');
    if ($purpose === 'feedback' && !$image && !in_array($extension, ['txt', 'log', 'pdf', 'mp4', 'webm', 'json', 'zip'], true)) throw new ApiError('file_type_forbidden', 415);
    if ($purpose === 'voice') {
        if (!in_array($extension, ['webm', 'ogg', 'm4a', 'mp3', 'wav'], true)) throw new ApiError('file_type_forbidden', 415);
        $mime = match ($extension) { 'webm' => 'audio/webm', 'ogg' => 'audio/ogg', 'm4a' => 'audio/mp4', 'wav' => 'audio/wav', default => 'audio/mpeg' };
    } elseif ($extension === 'webm' && $detected === 'audio/webm') {
        $mime = 'audio/webm';
    }
    $diskName = bin2hex(random_bytes(24)) . '.bin';
    $path = config()['upload_dir'] . '/' . $diskName;
    if (!($uploaded ? move_uploaded_file($tmpPath, $path) : rename($tmpPath, $path))) throw new ApiError('upload_failed', 500);
    @chmod($path, 0600);
    try {
        $id = insertId('INSERT INTO files(owner_id,disk_name,original_name,mime,size,created_at,purpose) VALUES(?,?,?,?,?,?,?)', [$userId, $diskName, $name, $mime, $size, time(), $purpose]);
    } catch (Throwable $error) {
        @unlink($path);
        throw $error;
    }
    return fileObject(query('SELECT * FROM files WHERE id=?', [$id])->fetch());
}

function officeContainer(string $path, string $extension): bool
{
    $head = (string)file_get_contents($path, false, null, 0, 4);
    if ($head !== "PK\x03\x04") return false;
    if (!class_exists(ZipArchive::class)) return true;
    $zip = new ZipArchive();
    if ($zip->open($path, ZipArchive::RDONLY) !== true) return false;
    $ok = match ($extension) {
        'docx' => $zip->locateName('word/document.xml') !== false,
        'xlsx' => $zip->locateName('xl/workbook.xml') !== false,
        'pptx' => $zip->locateName('ppt/presentation.xml') !== false,
        default => $zip->locateName('mimetype') !== false,
    };
    $zip->close();
    return $ok;
}

function uploadTmpDir(): string
{
    $dir = config()['upload_dir'] . '/.partial';
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Upload storage is not writable.');
    return $dir;
}

function uploadsHandle(string $action, array $input, array $user): array
{
    $userId = (int)$user['id'];
    switch ($action) {
        case 'files.upload':
            rateLimit('upload', 30, 60, (string)$userId);
            if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > UPLOAD_CHUNK_BYTES + 262144) throw new ApiError('file_too_large', 413);
            $file = $_FILES['file'] ?? null;
            if (!is_array($file) || !isset($file['error']) || is_array($file['error'])) throw new ApiError('upload_failed');
            if (in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) throw new ApiError('file_too_large', 413);
            if ($file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) throw new ApiError('upload_failed');
            $purpose = is_string($_POST['purpose'] ?? null) ? $_POST['purpose'] : 'file';
            return registerUpload($file['tmp_name'], uploadName($file['name']), $purpose, $user, true);
        case 'files.upload_init':
            rateLimit('upload_session', 30, 60, (string)$userId);
            $name = uploadName($input['name'] ?? '');
            $size = intValue($input['size'] ?? null);
            $purpose = $input['purpose'] ?? 'file';
            if (!in_array($purpose, UPLOAD_PURPOSES, true)) throw new ApiError('file_type_forbidden', 415);
            $limit = uploadPurposeLimit($purpose, $userId);
            if ($size > $limit) throw new ApiError($purpose === 'file' && !premiumActive($userId) && $size <= uploadLimit($userId, true) ? 'file_too_large_premium' : 'file_too_large', 413);
            if (!isset(uploadFormats()[strtolower(pathinfo($name, PATHINFO_EXTENSION))])) throw new ApiError('file_type_forbidden', 415);
            if ((int)query('SELECT COALESCE(SUM(size),0) FROM upload_sessions WHERE user_id=? AND expires_at>?', [$userId, time()])->fetchColumn() + $size > 2 * uploadLimit($userId)) throw new ApiError('upload_busy', 429);
            $id = bin2hex(random_bytes(20));
            query('INSERT INTO upload_sessions(id,user_id,name,size,purpose,created_at,expires_at) VALUES(?,?,?,?,?,?,?)', [$id, $userId, $name, $size, $purpose, time(), time() + 6 * 3600]);
            touch(uploadTmpDir() . '/' . $id . '.part');
            @chmod(uploadTmpDir() . '/' . $id . '.part', 0600);
            return ['upload_id' => $id, 'chunk_size' => UPLOAD_CHUNK_BYTES, 'received' => 0, 'size' => $size];
        case 'files.upload_chunk':
            rateLimit('upload_chunk', 600, 60, (string)$userId);
            $id = uploadSessionId($_GET['upload_id'] ?? null);
            $offset = intValue($_GET['offset'] ?? null, 0);
            return transaction(function () use ($id, $offset, $userId): array {
                $session = query('SELECT * FROM upload_sessions WHERE id=? AND user_id=? AND expires_at>? FOR UPDATE', [$id, $userId, time()])->fetch();
                if (!$session) throw new ApiError('upload_not_found', 404);
                if ($offset !== (int)$session['received']) return ['upload_id' => $id, 'received' => (int)$session['received'], 'size' => (int)$session['size'], 'resync' => true];
                $length = (int)($_SERVER['CONTENT_LENGTH'] ?? -1);
                if ($length <= 0 || $length > UPLOAD_CHUNK_BYTES || $offset + $length > (int)$session['size']) throw new ApiError('invalid_chunk', 400);
                // Stream the request body to disk: memory use stays bounded regardless of file size.
                $in = fopen('php://input', 'rb');
                $out = fopen(uploadTmpDir() . '/' . $id . '.part', 'cb');
                if (!$in || !$out) throw new ApiError('upload_failed', 500);
                ftruncate($out, $offset);
                fseek($out, $offset);
                $written = stream_copy_to_stream($in, $out, $length);
                fclose($in);
                fclose($out);
                if ($written !== $length) {
                    $handle = fopen(uploadTmpDir() . '/' . $id . '.part', 'cb');
                    ftruncate($handle, $offset);
                    fclose($handle);
                    throw new ApiError('invalid_chunk', 400);
                }
                query('UPDATE upload_sessions SET received=? WHERE id=?', [$offset + $length, $id]);
                return ['upload_id' => $id, 'received' => $offset + $length, 'size' => (int)$session['size']];
            });
        case 'files.upload_finish':
            $id = uploadSessionId($input['upload_id'] ?? null);
            $session = query('SELECT * FROM upload_sessions WHERE id=? AND user_id=?', [$id, $userId])->fetch();
            if (!$session) throw new ApiError('upload_not_found', 404);
            if ((int)$session['received'] !== (int)$session['size']) throw new ApiError('upload_incomplete', 409);
            query('DELETE FROM upload_sessions WHERE id=?', [$id]);
            $path = uploadTmpDir() . '/' . $id . '.part';
            try {
                return registerUpload($path, $session['name'], $session['purpose'], $user, false);
            } finally {
                if (is_file($path)) @unlink($path);
            }
        case 'files.upload_cancel':
            $id = uploadSessionId($input['upload_id'] ?? null);
            if (query('DELETE FROM upload_sessions WHERE id=? AND user_id=? RETURNING id', [$id, $userId])->fetchColumn()) @unlink(uploadTmpDir() . '/' . $id . '.part');
            return ['cancelled' => true];
    }
    throw new ApiError('invalid_action', 404);
}

function uploadSessionId(mixed $value): string
{
    if (!is_string($value) || !preg_match('/^[a-f0-9]{40}$/D', $value)) throw new ApiError('upload_not_found', 404);
    return $value;
}

function uploadsCleanup(): int
{
    $count = 0;
    foreach (query('DELETE FROM upload_sessions WHERE expires_at<? RETURNING id', [time()])->fetchAll(PDO::FETCH_COLUMN) as $id) {
        @unlink(uploadTmpDir() . '/' . $id . '.part');
        $count++;
    }
    return $count;
}
