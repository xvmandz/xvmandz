<?php
declare(strict_types=1);

// Messages: sending (text, files, albums, stickers, polls, comments), scheduling, reactions, stars, polls.

const REACTION_MAX_PER_USER = 3;

function reactionValue(mixed $value): string
{
    if (!is_string($value) || $value === '' || strlen($value) > 32 || !preg_match('//u', $value)) throw new ApiError('invalid_emoji');
    // One emoji grapheme: pictographic base, optional skin tone / variation selector / ZWJ sequence / keycap / flag.
    if (!preg_match('/^(?:\p{Extended_Pictographic}[\x{FE0F}\x{1F3FB}-\x{1F3FF}]?(?:\x{200D}\p{Extended_Pictographic}[\x{FE0F}\x{1F3FB}-\x{1F3FF}]?)*|\p{Regional_Indicator}{2}|[0-9#*]\x{FE0F}?\x{20E3})$/u', $value)) {
        throw new ApiError('invalid_emoji');
    }
    return $value;
}

function messageClientId(mixed $value): string
{
    $clientId = textValue($value ?? '', 100, 8);
    if (!preg_match('/^[A-Za-z0-9_.:-]+$/', $clientId)) throw new ApiError('invalid_client_id');
    return $clientId;
}

/** Validates a message payload; returns the normalized fields used for insert or scheduling. */
function messagePayload(array $body, array $user, array $conversation, ?array $source = null): array
{
    $userId = (int)$user['id'];
    $conversationId = (int)$conversation['id'];
    $threadRoot = !empty($body['thread_root_id']) ? intValue($body['thread_root_id']) : null;
    if ($threadRoot) {
        if ($conversation['type'] !== 'channel' || !communitySettings($conversation)['comments_enabled']) throw new ApiError('comments_disabled', 403);
        $root = messageFor($threadRoot, $userId);
        if ((int)$root['conversation_id'] !== $conversationId || $root['thread_root_id'] !== null || in_array($root['kind'], ['call', 'system'], true)) throw new ApiError('invalid_thread');
        if (!empty($conversation['archived_at'])) throw new ApiError('community_archived', 403);
    } else {
        mayPost($conversation, $user);
    }
    if ($source && in_array($source['kind'], ['call', 'system', 'poll'], true)) throw new ApiError('system_message_action', 400);
    $text = $source ? $source['text'] : textValue($body['text'] ?? '', 10000);
    $fileId = $source ? ($source['file_id'] !== null ? (int)$source['file_id'] : null) : (!empty($body['file_id']) ? intValue($body['file_id']) : null);
    $fileIds = [];
    if ($source && $source['kind'] === 'album') {
        $fileIds = array_map('intval', query('SELECT file_id FROM message_files WHERE message_id=? ORDER BY position', [$source['id']])->fetchAll(PDO::FETCH_COLUMN));
    } elseif (!$source && isset($body['file_ids'])) {
        if (!is_array($body['file_ids']) || !array_is_list($body['file_ids']) || count($body['file_ids']) > 10) throw new ApiError('invalid_files');
        $fileIds = array_values(array_unique(array_map(fn($id) => intValue($id), $body['file_ids'])));
    }
    if (count($fileIds) === 1 && !$fileId) {
        $fileId = $fileIds[0];
        $fileIds = [];
    }
    if ($fileIds) $fileId = $fileIds[0];
    $owned = $fileIds ?: ($fileId ? [$fileId] : []);
    $files = $owned ? query('SELECT * FROM files WHERE id IN (' . placeholders($owned) . ')', $owned)->fetchAll() : [];
    if (count($files) !== count($owned)) throw new ApiError('file_not_found', 404);
    foreach ($files as $file) {
        if ((!$source && (int)$file['owner_id'] !== $userId) || in_array($file['purpose'], ['feedback', 'avatar', 'sticker'], true) && !$source) throw new ApiError('file_not_found', 404);
    }
    $stickerId = $source ? ($source['sticker_id'] !== null ? (int)$source['sticker_id'] : null) : (!empty($body['sticker_id']) ? intValue($body['sticker_id']) : null);
    if ($stickerId && !$source) stickerUsable($stickerId, $userId);
    $poll = null;
    if (!$source && isset($body['poll'])) {
        if (!is_array($body['poll'])) throw new ApiError('invalid_poll');
        $options = $body['poll']['options'] ?? null;
        if (!is_array($options) || !array_is_list($options) || count($options) < 2 || count($options) > 10) throw new ApiError('invalid_poll');
        $poll = [
            'question' => textValue($body['poll']['question'] ?? '', 300, 1),
            'options' => array_map(fn($option) => textValue($option, 100, 1), $options),
            'multiple' => ($body['poll']['multiple'] ?? false) === true,
            'anonymous' => ($body['poll']['anonymous'] ?? true) !== false,
        ];
        if (count(array_unique(array_map('mb_strtolower', $poll['options']))) !== count($poll['options'])) throw new ApiError('invalid_poll');
    }
    if ($text === '' && !$fileId && !$stickerId && !$poll) throw new ApiError('message_empty');
    $replyId = !empty($body['reply_to']) ? intValue($body['reply_to']) : null;
    if ($replyId) {
        $reply = messageFor($replyId, $userId);
        if ((int)$reply['conversation_id'] !== $conversationId) throw new ApiError('invalid_reply');
        if ($threadRoot !== null && (int)$reply['id'] !== $threadRoot && (int)($reply['thread_root_id'] ?? 0) !== $threadRoot) throw new ApiError('invalid_reply');
    }
    $first = $files[0] ?? null;
    if ($poll) $kind = 'poll';
    elseif ($stickerId) $kind = 'sticker';
    elseif ($fileIds) $kind = 'album';
    elseif ($first) $kind = ($source ? $source['kind'] === 'voice' : ($first['purpose'] ?? '') === 'voice') ? 'voice' : 'file';
    else $kind = 'text';
    return compact('text', 'fileId', 'fileIds', 'stickerId', 'poll', 'replyId', 'threadRoot', 'kind');
}

function sendMessage(array $body, array $user, ?array $source = null): array
{
    $userId = (int)$user['id'];
    $conversationId = intValue($body['conversation_id'] ?? null);
    $conversation = conversationFor($conversationId, $userId);
    $clientId = messageClientId($body['client_id'] ?? '');
    $existing = query('SELECT * FROM messages WHERE sender_id=? AND client_id=?', [$userId, $clientId])->fetch();
    if ($existing) {
        if ((int)$existing['conversation_id'] !== $conversationId) throw new ApiError('client_id_conflict', 409);
        return normalizedMessage($existing, $userId);
    }
    $peer = directPeer($conversation, $userId);
    if ($peer !== null && !canStartDirect($userId, $peer)) throw new ApiError(blockedEither($userId, $peer) ? 'user_blocked' : 'privacy_restricted', 403);
    rateLimit('send', 90, 60, (string)$userId);
    $payload = messagePayload($body, $user, $conversation, $source);
    return transaction(function () use ($conversationId, $userId, $payload, $source, $clientId): array {
        lockKey('send:' . $userId . ':' . $clientId);
        $existing = query('SELECT * FROM messages WHERE sender_id=? AND client_id=?', [$userId, $clientId])->fetch();
        if ($existing) {
            if ((int)$existing['conversation_id'] !== $conversationId) throw new ApiError('client_id_conflict', 409);
            return normalizedMessage($existing, $userId);
        }
        lockKey('chat:' . $conversationId);
        $now = time();
        $pollId = null;
        if ($payload['poll']) {
            $pollId = insertId('INSERT INTO polls(conversation_id,creator_id,question,multiple,anonymous,created_at) VALUES(?,?,?,?,?,?)', [$conversationId, $userId, $payload['poll']['question'], $payload['poll']['multiple'] ? 'true' : 'false', $payload['poll']['anonymous'] ? 'true' : 'false', $now]);
            foreach ($payload['poll']['options'] as $position => $option) query('INSERT INTO poll_options(poll_id,position,text) VALUES(?,?,?)', [$pollId, $position, $option]);
        }
        $id = insertId('INSERT INTO messages(conversation_id,sender_id,text,kind,file_id,reply_to,forwarded_from,client_id,created_at,updated_at,thread_root_id,poll_id,sticker_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [$conversationId, $userId, $payload['text'], $payload['kind'], $payload['fileId'], $payload['replyId'], $source['id'] ?? null, $clientId, $now, $now, $payload['threadRoot'], $pollId, $payload['stickerId']]);
        foreach ($payload['fileIds'] as $position => $fileId) query('INSERT INTO message_files(message_id,file_id,position) VALUES(?,?,?)', [$id, $fileId, $position]);
        if ($payload['threadRoot'] === null) query('UPDATE conversations SET updated_at=? WHERE id=?', [$now, $conversationId]);
        else query('UPDATE messages SET change_seq=change_seq WHERE id=?', [$payload['threadRoot']]);
        query('DELETE FROM typing WHERE conversation_id=? AND user_id=?', [$conversationId, $userId]);
        query("UPDATE conversation_members SET draft='',draft_updated_at=?,last_read_message_id=GREATEST(last_read_message_id,?),last_delivered_message_id=GREATEST(last_delivered_message_id,?) WHERE conversation_id=? AND user_id=?", [$now, $id, $id, $conversationId, $userId]);
        $message = messageFor($id, $userId);
        if ($payload['threadRoot'] !== null) commentNotification($message, $payload['threadRoot'], $payload['replyId']);
        else notificationMessage($message);
        return normalizedMessage($message, $userId);
    });
}

/** Comments notify the post author and the replied-to author, never every subscriber. */
function commentNotification(array $message, int $rootId, ?int $replyId): void
{
    $recipients = query('SELECT DISTINCT sender_id FROM messages WHERE id IN (?,?) AND sender_id<>?', [$rootId, $replyId ?? $rootId, $message['sender_id']])->fetchAll(PDO::FETCH_COLUMN);
    foreach ($recipients as $recipient) notificationEnqueue((int)$recipient, 'message', (int)$message['id']);
}

function scheduleMessage(array $body, array $user): array
{
    $userId = (int)$user['id'];
    $conversation = conversationFor(intValue($body['conversation_id'] ?? null), $userId);
    $sendAt = intValue($body['send_at'] ?? null);
    if ($sendAt < time() + 30 || $sendAt > time() + 366 * 86400) throw new ApiError('invalid_schedule');
    $peer = directPeer($conversation, $userId);
    if ($peer !== null && !canStartDirect($userId, $peer)) throw new ApiError('privacy_restricted', 403);
    rateLimit('schedule', 60, 3600, (string)$userId);
    if ((int)query("SELECT COUNT(*) FROM scheduled_messages WHERE sender_id=? AND status='scheduled'", [$userId])->fetchColumn() >= 100) throw new ApiError('schedule_limit', 429);
    $payload = messagePayload($body, $user, $conversation);
    $stored = ['text' => $payload['text'], 'file_id' => $payload['fileId'], 'file_ids' => $payload['fileIds'], 'sticker_id' => $payload['stickerId'], 'poll' => $payload['poll'], 'reply_to' => $payload['replyId'], 'thread_root_id' => $payload['threadRoot'], 'kind' => $payload['kind']];
    $id = insertId('INSERT INTO scheduled_messages(conversation_id,sender_id,payload,send_at,created_at) VALUES(?,?,?,?,?)', [$conversation['id'], $userId, json_encode($stored, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), $sendAt, time()]);
    return ['scheduled' => scheduledObject(query('SELECT * FROM scheduled_messages WHERE id=?', [$id])->fetch())];
}

function scheduledObject(array $row): array
{
    $payload = json_decode($row['payload'], true) ?: [];
    return ['id' => (int)$row['id'], 'conversation_id' => (int)$row['conversation_id'], 'send_at' => (int)$row['send_at'], 'status' => $row['status'], 'text' => $payload['text'] ?? '', 'kind' => $payload['kind'] ?? 'text', 'has_file' => !empty($payload['file_id']), 'error' => $row['error_code'], 'created_at' => (int)$row['created_at']];
}

/** Publishes due scheduled messages. Safe to call concurrently (SKIP LOCKED); permissions are re-checked at send time. */
function publishDueScheduled(int $limit = 20): int
{
    $published = 0;
    $ids = query("SELECT id FROM scheduled_messages WHERE status='scheduled' AND send_at<=? ORDER BY send_at LIMIT " . max(1, min(100, $limit)), [time()])->fetchAll(PDO::FETCH_COLUMN);
    foreach ($ids as $scheduledId) {
        transaction(function () use ($scheduledId, &$published): void {
            $row = query("SELECT * FROM scheduled_messages WHERE id=? AND status='scheduled' FOR UPDATE SKIP LOCKED", [$scheduledId])->fetch();
            if (!$row) return;
            $sender = query('SELECT * FROM users WHERE id=?', [$row['sender_id']])->fetch();
            $payload = json_decode($row['payload'], true) ?: [];
            $body = ['conversation_id' => (int)$row['conversation_id'], 'client_id' => 'sched:' . $row['id'], 'text' => $payload['text'] ?? '', 'file_id' => $payload['file_id'] ?? null, 'file_ids' => $payload['file_ids'] ?: null, 'sticker_id' => $payload['sticker_id'] ?? null, 'poll' => $payload['poll'] ?? null, 'reply_to' => $payload['reply_to'] ?? null, 'thread_root_id' => $payload['thread_root_id'] ?? null, 'kind' => $payload['kind'] ?? null];
            $body = array_filter($body, fn($value) => $value !== null);
            query('SAVEPOINT scheduled_send');
            try {
                $previous = PrivacyCache::$viewer;
                PrivacyCache::$viewer = (int)$sender['id'];
                $message = sendMessage($body, $sender);
                PrivacyCache::$viewer = $previous;
                query("UPDATE scheduled_messages SET status='sent',message_id=? WHERE id=?", [$message['id'], $row['id']]);
                $published++;
            } catch (ApiError $error) {
                query('ROLLBACK TO SAVEPOINT scheduled_send');
                query("UPDATE scheduled_messages SET status='failed',error_code=? WHERE id=?", [$error->errorCode, $row['id']]);
            }
        });
    }
    return $published;
}

function pollObjects(array $pollIds, int $userId): array
{
    $result = [];
    foreach (query('SELECT * FROM polls WHERE id IN (' . placeholders($pollIds) . ')', $pollIds)->fetchAll() as $poll) {
        $result[$poll['id']] = ['id' => (int)$poll['id'], 'question' => $poll['question'], 'multiple' => (bool)$poll['multiple'], 'anonymous' => (bool)$poll['anonymous'], 'closed' => $poll['closed_at'] !== null, 'creator_id' => (int)$poll['creator_id'], 'options' => [], 'total_voters' => 0, 'voted' => false];
    }
    if (!$result) return [];
    foreach (query('SELECT o.id,o.poll_id,o.text,COUNT(v.user_id) AS votes,BOOL_OR(v.user_id=?) AS mine FROM poll_options o LEFT JOIN poll_votes v ON v.option_id=o.id WHERE o.poll_id IN (' . placeholders($pollIds) . ') GROUP BY o.id ORDER BY o.poll_id,o.position', array_merge([$userId], $pollIds))->fetchAll() as $option) {
        $result[$option['poll_id']]['options'][] = ['id' => (int)$option['id'], 'text' => $option['text'], 'votes' => (int)$option['votes'], 'mine' => (bool)$option['mine']];
        if ($option['mine']) $result[$option['poll_id']]['voted'] = true;
    }
    foreach (query('SELECT poll_id,COUNT(DISTINCT user_id) AS voters FROM poll_votes WHERE poll_id IN (' . placeholders($pollIds) . ') GROUP BY poll_id', $pollIds)->fetchAll() as $row) {
        $result[$row['poll_id']]['total_voters'] = (int)$row['voters'];
    }
    return $result;
}

function stickerObject(array $row): array
{
    return ['id' => (int)$row['id'], 'pack_id' => (int)$row['pack_id'], 'emoji' => $row['emoji'], 'url' => $row['asset'] ?? 'media.php?id=' . (int)$row['file_id']];
}

function stickerUsable(int $stickerId, int $userId): array
{
    $row = query('SELECT s.*,p.system,p.owner_id FROM stickers s JOIN sticker_packs p ON p.id=s.pack_id WHERE s.id=?', [$stickerId])->fetch();
    if (!$row || (!$row['system'] && (int)$row['owner_id'] !== $userId && !query('SELECT 1 FROM user_sticker_packs WHERE user_id=? AND pack_id=?', [$userId, $row['pack_id']])->fetchColumn())) {
        throw new ApiError('sticker_not_found', 404);
    }
    return $row;
}

function stickerPacks(int $userId): array
{
    $packs = query('SELECT p.*,(p.owner_id=?) AS owned FROM sticker_packs p WHERE p.system OR p.owner_id=? OR EXISTS(SELECT 1 FROM user_sticker_packs u WHERE u.pack_id=p.id AND u.user_id=?) ORDER BY p.system DESC,p.id', [$userId, $userId, $userId])->fetchAll();
    if (!$packs) return [];
    $ids = array_map('intval', array_column($packs, 'id'));
    $stickers = [];
    foreach (query('SELECT * FROM stickers WHERE pack_id IN (' . placeholders($ids) . ') ORDER BY pack_id,position,id', $ids)->fetchAll() as $row) $stickers[$row['pack_id']][] = stickerObject($row);
    return array_map(fn($pack) => ['id' => (int)$pack['id'], 'title' => $pack['title'], 'system' => (bool)$pack['system'], 'owned' => (bool)$pack['owned'], 'stickers' => $stickers[$pack['id']] ?? []], $packs);
}

function stickersHandle(string $action, array $input, array $user): array
{
    $userId = (int)$user['id'];
    if ($action === 'stickers.packs') return ['packs' => stickerPacks($userId)];
    rateLimit('stickers', 60, 3600, (string)$userId);
    switch ($action) {
        case 'stickers.pack_create':
            if ((int)query('SELECT COUNT(*) FROM sticker_packs WHERE owner_id=?', [$userId])->fetchColumn() >= 20) throw new ApiError('sticker_pack_limit', 429);
            insertId('INSERT INTO sticker_packs(owner_id,title,created_at) VALUES(?,?,?)', [$userId, textValue($input['title'] ?? '', 64, 1), time()]);
            break;
        case 'stickers.add':
            $pack = query('SELECT * FROM sticker_packs WHERE id=? AND owner_id=?', [intValue($input['pack_id'] ?? null), $userId])->fetch();
            if (!$pack) throw new ApiError('sticker_pack_not_found', 404);
            if ((int)query('SELECT COUNT(*) FROM stickers WHERE pack_id=?', [$pack['id']])->fetchColumn() >= 60) throw new ApiError('sticker_limit', 429);
            $file = query("SELECT * FROM files WHERE id=? AND owner_id=? AND purpose='sticker'", [intValue($input['file_id'] ?? null), $userId])->fetch();
            if (!$file) throw new ApiError('invalid_sticker', 415);
            $emoji = isset($input['emoji']) && $input['emoji'] !== '' ? reactionValue($input['emoji']) : '';
            query('INSERT INTO stickers(pack_id,file_id,emoji,position) VALUES(?,?,?,(SELECT COALESCE(MAX(position)+1,0) FROM stickers WHERE pack_id=?))', [$pack['id'], $file['id'], $emoji, $pack['id']]);
            break;
        case 'stickers.remove':
            query('DELETE FROM stickers s USING sticker_packs p WHERE s.id=? AND p.id=s.pack_id AND p.owner_id=?', [intValue($input['sticker_id'] ?? null), $userId]);
            break;
        case 'stickers.pack_delete':
            query('DELETE FROM sticker_packs WHERE id=? AND owner_id=?', [intValue($input['pack_id'] ?? null), $userId]);
            break;
        case 'stickers.install':
            // A pack is installable from a sticker message the user can actually see.
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $packId = (int)query('SELECT pack_id FROM stickers WHERE id=?', [$message['sticker_id']])->fetchColumn();
            if (!$packId) throw new ApiError('sticker_pack_not_found', 404);
            query('INSERT INTO user_sticker_packs(user_id,pack_id,added_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [$userId, $packId, time()]);
            break;
        case 'stickers.uninstall':
            query('DELETE FROM user_sticker_packs WHERE user_id=? AND pack_id=?', [$userId, intValue($input['pack_id'] ?? null)]);
            break;
        default:
            throw new ApiError('invalid_action', 404);
    }
    return ['packs' => stickerPacks($userId)];
}

function messagesList(array $input, int $userId): array
{
    $conversationId = intValue($input['conversation_id'] ?? null);
    conversationFor($conversationId, $userId);
    $limit = isset($input['limit']) ? min(100, intValue($input['limit'])) : 50;
    $after = isset($input['after_id']) ? intValue($input['after_id'], 0) : 0;
    $before = isset($input['before_id']) ? intValue($input['before_id']) : null;
    $around = isset($input['around_id']) ? intValue($input['around_id']) : null;
    $cursor = (int)query('SELECT COALESCE(MAX(change_seq),0) FROM messages WHERE conversation_id=?', [$conversationId])->fetchColumn();
    $base = 'conversation_id=? AND thread_root_id IS NULL AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=messages.id AND h.user_id=?)';
    if ($around !== null) {
        $older = query('SELECT * FROM messages WHERE ' . $base . ' AND id<? ORDER BY id DESC LIMIT ' . ($limit + 1), [$conversationId, $userId, $around])->fetchAll();
        $newer = query('SELECT * FROM messages WHERE ' . $base . ' AND id>=? ORDER BY id ASC LIMIT ' . ($limit + 1), [$conversationId, $userId, $around])->fetchAll();
        $hasMore = count($older) > $limit;
        $hasNewer = count($newer) > $limit;
        $rows = array_merge(array_reverse(array_slice($older, 0, $limit)), array_slice($newer, 0, $limit));
    } else {
        $params = [$conversationId, $userId];
        $where = $base;
        if ($after > 0) { $where .= ' AND id>?'; $params[] = $after; }
        if ($before !== null) { $where .= ' AND id<?'; $params[] = $before; }
        $direction = $after > 0 ? 'ASC' : 'DESC';
        $rows = query('SELECT * FROM messages WHERE ' . $where . ' ORDER BY id ' . $direction . ' LIMIT ' . ($limit + 1), $params)->fetchAll();
        $hasMore = count($rows) > $limit;
        if ($hasMore) array_pop($rows);
        if ($direction === 'DESC') $rows = array_reverse($rows);
        $hasNewer = false;
    }
    $pins = query('SELECT * FROM messages WHERE conversation_id=? AND pinned=1 AND deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=messages.id AND h.user_id=?) ORDER BY pinned_at DESC,id DESC LIMIT 20', [$conversationId, $userId])->fetchAll();
    return ['change_cursor' => $cursor, 'messages' => normalizedMessages($rows, $userId), 'has_more' => $hasMore, 'has_newer' => $hasNewer, 'pinned_messages' => normalizedMessages($pins, $userId)];
}

function messageDeleteAllowed(array $message, array $conversation, array $user): bool
{
    if ((int)$message['sender_id'] === (int)$user['id'] || in_array($conversation['type'], ['direct', 'saved'], true)) return true;
    if ($message['thread_root_id'] !== null && memberCan($conversation, $user, 'moderate_comments')) return true;
    return memberCan($conversation, $user, 'delete_others');
}

function deleteMessageScoped(array $message, array $user, string $scope): void
{
    $userId = (int)$user['id'];
    $conversation = conversationFor((int)$message['conversation_id'], $userId);
    if ($scope === 'self') {
        transaction(function () use ($message, $userId): void {
            lockKey('chat:' . $message['conversation_id']);
            query('INSERT INTO message_hidden(user_id,message_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [$userId, $message['id'], time()]);
            // Advance the change cursor for the account's other devices, without deleting content.
            query('UPDATE messages SET change_seq=change_seq WHERE id=? OR reply_to=?', [$message['id'], $message['id']]);
        });
        return;
    }
    if (!messageDeleteAllowed($message, $conversation, $user)) throw new ApiError('delete_forbidden', 403);
    transaction(function () use ($message, $userId, $conversation): void {
        lockKey('chat:' . $message['conversation_id']);
        query('UPDATE messages SET deleted=1,text=?,file_id=NULL,sticker_id=NULL,pinned=0,updated_at=? WHERE id=?', ['', time(), $message['id']]);
        query('DELETE FROM message_files WHERE message_id=?', [$message['id']]);
        query('DELETE FROM reactions WHERE message_id=?', [$message['id']]);
        query('DELETE FROM message_stars WHERE message_id=?', [$message['id']]);
        query('UPDATE messages SET change_seq=change_seq WHERE reply_to=? OR id=?', [$message['id'], $message['thread_root_id'] ?? 0]);
        if ((int)$message['sender_id'] !== $userId && in_array($conversation['type'], ['group', 'channel'], true)) {
            communityAudit((int)$conversation['id'], $userId, 'message.delete', (int)$message['sender_id'], ['message_id' => (int)$message['id']]);
        }
    });
}

function messagesHandle(string $action, array $input, array $user): mixed
{
    $userId = (int)$user['id'];
    switch ($action) {
        case 'messages.list':
            return messagesList($input, $userId);
        case 'messages.thread':
            $root = messageFor(intValue($input['message_id'] ?? null), $userId);
            $after = intValue($input['after_id'] ?? 0, 0);
            $rows = query('SELECT * FROM messages WHERE thread_root_id=? AND id>? AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=messages.id AND h.user_id=?) ORDER BY id LIMIT 200', [$root['id'], $after, $userId])->fetchAll();
            $authors = array_values(array_unique(array_column($rows, 'sender_id')));
            $users = $authors ? query('SELECT * FROM users WHERE id IN (' . placeholders($authors) . ')', $authors)->fetchAll() : [];
            privacyPrefetch(array_column($users, 'id'), $userId);
            return ['root' => normalizedMessage($root, $userId), 'comments' => normalizedMessages($rows, $userId), 'authors' => array_map(fn($row) => normalizedUser($row), $users)];
        case 'messages.send':
            if (isset($input['send_at'])) return scheduleMessage($input, $user);
            return sendMessage($input, $user);
        case 'messages.edit':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $conversation = conversationFor((int)$message['conversation_id'], $userId);
            $own = (int)$message['sender_id'] === $userId;
            if (!$own && !($conversation['type'] === 'channel' && $message['thread_root_id'] === null && memberCan($conversation, $user, 'edit_others'))) throw new ApiError('edit_forbidden', 403);
            if (in_array($message['kind'], ['call', 'system', 'sticker', 'poll'], true)) throw new ApiError('system_message_action');
            $text = textValue($input['text'] ?? '', 10000, $message['file_id'] ? 0 : 1);
            query('UPDATE messages SET text=?,edited=1,updated_at=? WHERE id=?', [$text, time(), $message['id']]);
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'messages.delete':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId, true);
            $scope = $input['scope'] ?? 'everyone';
            if (!in_array($scope, ['self', 'everyone'], true)) throw new ApiError('invalid_delete_scope');
            deleteMessageScoped($message, $user, $scope);
            return normalizedMessage(messageFor((int)$message['id'], $userId, true), $userId);
        case 'messages.delete_many':
            $ids = $input['message_ids'] ?? null;
            $scope = $input['scope'] ?? 'self';
            if (!is_array($ids) || !array_is_list($ids) || !$ids || count($ids) > 100 || !in_array($scope, ['self', 'everyone'], true)) throw new ApiError('invalid_messages');
            rateLimit('bulk', 30, 60, (string)$userId);
            $messages = array_map(fn($id) => messageFor(intValue($id), $userId, true), array_unique($ids));
            // Validate all before changing anything: a bulk delete is all-or-nothing.
            if ($scope === 'everyone') foreach ($messages as $message) if (!messageDeleteAllowed($message, conversationFor((int)$message['conversation_id'], $userId), $user)) throw new ApiError('delete_forbidden', 403);
            transaction(function () use ($messages, $user, $scope): void { foreach ($messages as $message) deleteMessageScoped($message, $user, $scope); });
            return ['messages' => normalizedMessages(array_map(fn($message) => messageFor((int)$message['id'], $userId, true), $messages), $userId)];
        case 'messages.react':
            rateLimit('reaction', 90, 60, (string)$userId);
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $emoji = reactionValue($input['emoji'] ?? '');
            if (in_array($message['kind'], ['call', 'system'], true)) throw new ApiError('system_message_action');
            $conversation = conversationFor((int)$message['conversation_id'], $userId);
            if ($conversation['type'] === 'channel') {
                $settings = communitySettings($conversation);
                if (!$settings['reactions_enabled']) throw new ApiError('reactions_disabled', 403);
                if ($settings['allowed_reactions'] && !in_array($emoji, $settings['allowed_reactions'], true)) throw new ApiError('reaction_not_allowed', 403);
            }
            transaction(function () use ($message, $userId, $emoji): void {
                query('SELECT id FROM messages WHERE id=? FOR UPDATE', [$message['id']]);
                $exists = query('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [$message['id'], $userId, $emoji])->fetchColumn();
                if ($exists) {
                    query('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [$message['id'], $userId, $emoji]);
                } else {
                    if ((int)query('SELECT COUNT(*) FROM reactions WHERE message_id=? AND user_id=?', [$message['id'], $userId])->fetchColumn() >= REACTION_MAX_PER_USER) throw new ApiError('reaction_limit', 409);
                    query('INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)', [$message['id'], $userId, $emoji, time()]);
                }
                query('UPDATE messages SET updated_at=? WHERE id=?', [time(), $message['id']]);
            });
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'messages.reactors':
            rateLimit('reactors', 60, 60, (string)$userId);
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $conversation = conversationFor((int)$message['conversation_id'], $userId);
            // Channel reactions are anonymous for readers; staff sees who reacted.
            if ($conversation['type'] === 'channel' && !memberCan($conversation, $user, 'view_stats')) throw new ApiError('reactors_hidden', 403);
            $rows = query('SELECT u.*,r.emoji FROM reactions r JOIN users u ON u.id=r.user_id WHERE r.message_id=? ORDER BY r.created_at,u.id LIMIT 200', [$message['id']])->fetchAll();
            privacyPrefetch(array_column($rows, 'id'), $userId);
            $result = [];
            foreach ($rows as $row) if (!isBlocked((int)$row['id'], $userId)) $result[] = ['emoji' => $row['emoji'], 'user' => normalizedUser($row)];
            return ['reactors' => $result];
        case 'messages.pin':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $conversation = conversationFor((int)$message['conversation_id'], $userId);
            if (!memberCan($conversation, $user, 'pin')) throw new ApiError('pin_forbidden', 403);
            if ($message['thread_root_id'] !== null) throw new ApiError('pin_forbidden', 403);
            $pinned = !empty($input['pinned']);
            if ($pinned && (int)query('SELECT COUNT(*) FROM messages WHERE conversation_id=? AND pinned=1 AND deleted=0', [$conversation['id']])->fetchColumn() >= 20 && !$message['pinned']) throw new ApiError('pin_limit', 409);
            query('UPDATE messages SET pinned=?,pinned_at=?,updated_at=? WHERE id=?', [$pinned ? 1 : 0, $pinned ? time() : 0, time(), $message['id']]);
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'messages.forward':
            $source = messageFor(intValue($input['message_id'] ?? null), $userId);
            return sendMessage($input, $user, $source);
        case 'messages.forward_many':
            $ids = $input['message_ids'] ?? null;
            if (!is_array($ids) || !array_is_list($ids) || !$ids || count($ids) > 50) throw new ApiError('invalid_messages');
            $prefix = messageClientId($input['client_id'] ?? '');
            $sources = array_map(fn($id) => messageFor(intValue($id), $userId), $ids);
            usort($sources, fn($a, $b) => (int)$a['id'] <=> (int)$b['id']);
            $sent = [];
            foreach ($sources as $index => $source) $sent[] = sendMessage(['conversation_id' => $input['conversation_id'] ?? null, 'client_id' => substr($prefix, 0, 90) . ':' . $index], $user, $source);
            return ['messages' => $sent];
        case 'messages.save':
            $source = messageFor(intValue($input['message_id'] ?? null), $userId);
            return sendMessage(['conversation_id' => savedConversation($userId), 'client_id' => 'save:message:' . $source['id'], 'text' => ''], $user, $source);
        case 'messages.star':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            if (!empty($input['starred'])) query('INSERT INTO message_stars(user_id,message_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [$userId, $message['id'], time()]);
            else query('DELETE FROM message_stars WHERE user_id=? AND message_id=?', [$userId, $message['id']]);
            return normalizedMessage($message, $userId);
        case 'messages.starred':
            $rows = query('SELECT m.* FROM message_stars s JOIN messages m ON m.id=s.message_id JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=s.user_id WHERE s.user_id=? AND m.deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=s.user_id) ORDER BY s.created_at DESC LIMIT 200', [$userId])->fetchAll();
            return ['messages' => normalizedMessages($rows, $userId)];
        case 'messages.scheduled':
            $conversationId = intValue($input['conversation_id'] ?? null);
            conversationFor($conversationId, $userId);
            return ['scheduled' => array_map('scheduledObject', query("SELECT * FROM scheduled_messages WHERE sender_id=? AND conversation_id=? AND status IN ('scheduled','failed') ORDER BY send_at LIMIT 100", [$userId, $conversationId])->fetchAll())];
        case 'messages.scheduled_cancel':
            query("UPDATE scheduled_messages SET status='cancelled' WHERE id=? AND sender_id=? AND status IN ('scheduled','failed')", [intValue($input['id'] ?? null), $userId]);
            return ['cancelled' => true];
        case 'messages.scheduled_now':
            $updated = query("UPDATE scheduled_messages SET send_at=?,status='scheduled',error_code=NULL WHERE id=? AND sender_id=? AND status IN ('scheduled','failed') RETURNING id", [time(), intValue($input['id'] ?? null), $userId])->fetchColumn();
            if (!$updated) throw new ApiError('scheduled_not_found', 404);
            publishDueScheduled(5);
            return scheduledObject(query('SELECT * FROM scheduled_messages WHERE id=?', [$updated])->fetch());
        case 'polls.vote':
            rateLimit('poll_vote', 60, 60, (string)$userId);
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            if ($message['kind'] !== 'poll' || !$message['poll_id']) throw new ApiError('poll_not_found', 404);
            $options = $input['option_ids'] ?? null;
            if (!is_array($options) || !array_is_list($options) || count($options) > 10) throw new ApiError('invalid_poll_vote');
            $options = array_values(array_unique(array_map(fn($id) => intValue($id), $options)));
            transaction(function () use ($message, $options, $userId): void {
                $poll = query('SELECT * FROM polls WHERE id=? FOR UPDATE', [$message['poll_id']])->fetch();
                if ($poll['closed_at'] !== null) throw new ApiError('poll_closed', 409);
                if (!$poll['multiple'] && count($options) > 1) throw new ApiError('invalid_poll_vote');
                if ($options && (int)query('SELECT COUNT(*) FROM poll_options WHERE poll_id=? AND id IN (' . placeholders($options) . ')', array_merge([$poll['id']], $options))->fetchColumn() !== count($options)) throw new ApiError('invalid_poll_vote');
                query('DELETE FROM poll_votes WHERE poll_id=? AND user_id=?', [$poll['id'], $userId]);
                foreach ($options as $option) query('INSERT INTO poll_votes(poll_id,option_id,user_id,created_at) VALUES(?,?,?,?)', [$poll['id'], $option, $userId, time()]);
                query('UPDATE messages SET updated_at=? WHERE id=?', [time(), $message['id']]);
            });
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'polls.close':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $poll = $message['poll_id'] ? query('SELECT * FROM polls WHERE id=?', [$message['poll_id']])->fetch() : null;
            if (!$poll) throw new ApiError('poll_not_found', 404);
            if ((int)$poll['creator_id'] !== $userId && !memberCan(conversationFor((int)$message['conversation_id'], $userId), $user, 'delete_others')) throw new ApiError('poll_close_forbidden', 403);
            query('UPDATE polls SET closed_at=COALESCE(closed_at,?) WHERE id=?', [time(), $poll['id']]);
            query('UPDATE messages SET updated_at=? WHERE id=?', [time(), $message['id']]);
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'polls.voters':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $poll = $message['poll_id'] ? query('SELECT * FROM polls WHERE id=?', [$message['poll_id']])->fetch() : null;
            if (!$poll) throw new ApiError('poll_not_found', 404);
            if ($poll['anonymous']) throw new ApiError('poll_anonymous', 403);
            $rows = query('SELECT u.*,v.option_id FROM poll_votes v JOIN users u ON u.id=v.user_id WHERE v.poll_id=? ORDER BY v.created_at LIMIT 500', [$poll['id']])->fetchAll();
            privacyPrefetch(array_column($rows, 'id'), $userId);
            return ['voters' => array_map(fn($row) => ['option_id' => (int)$row['option_id'], 'user' => normalizedUser($row)], $rows)];
    }
    throw new ApiError('invalid_action', 404);
}
