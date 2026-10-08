<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';
require dirname(__DIR__) . '/src/actions.php';
require dirname(__DIR__) . '/src/Calls.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

try {
    $readActions = ['bootstrap', 'users.search', 'users.profile', 'channels.search', 'conversations.list', 'messages.list', 'messages.search', 'sync', 'calls.poll', 'calls.history', 'notifications.list', 'notifications.resolve', 'push.status'];
    $writeActions = ['auth.register', 'auth.login', 'auth.logout', 'auth.password', 'profile.update', 'channels.join', 'channels.leave', 'channels.update', 'conversations.create', 'conversations.read', 'conversations.pin', 'messages.send', 'messages.edit', 'messages.delete', 'messages.react', 'messages.pin', 'messages.forward', 'messages.save', 'typing.set', 'files.upload', 'calls.start', 'calls.signal', 'calls.accept', 'calls.end', 'notifications.settings', 'notifications.chat', 'push.subscribe', 'push.unsubscribe'];
    $action = $_GET['action'] ?? '';
    if (!is_string($action) || !in_array($action, array_merge($readActions, $writeActions), true)) {
        throw new ApiError('invalid_action', 404);
    }
    $read = in_array($action, $readActions, true);
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== ($read ? 'GET' : 'POST')) {
        header('Allow: ' . ($read ? 'GET' : 'POST'));
        throw new ApiError('method_not_allowed', 405);
    }
    startSession();
    if (!$read) {
        verifyCsrf();
    }
    $input = $read ? $_GET : ($action === 'files.upload' ? $_POST : jsonBody());
    // Polling never holds the per-session filesystem lock while querying data.
    if ($read) {
        session_write_close();
    }
    $data = dispatchAction($action, $input);
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    echo json_encode(['ok' => true, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
} catch (ApiError $error) {
    http_response_code($error->status);
    echo json_encode(['ok' => false, 'error' => ['code' => $error->errorCode, 'message' => $error->getMessage()]], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    error_log('PingUp API failure: '.get_class($error).' code='.preg_replace('/[^A-Za-z0-9_-]/','',(string)$error->getCode()));
    $busy = $error instanceof PDOException && in_array($error->getCode(),['40001','40P01','55P03','57014','53300'],true);
    http_response_code($busy ? 503 : 500);
    if ($busy) {
        header('Retry-After: 2');
    }
    echo json_encode(['ok' => false, 'error' => ['code' => $busy ? 'storage_busy' : 'internal_error', 'message' => $busy ? 'storage_busy' : 'internal_error']]);
}
