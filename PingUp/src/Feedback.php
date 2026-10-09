<?php
declare(strict_types=1);

// Feedback centre: user tickets with history, attachments, statuses and staff replies/internal notes.

const FEEDBACK_STATUSES = ['new', 'review', 'need_info', 'in_progress', 'fixed', 'closed', 'rejected'];
const FEEDBACK_PRIORITIES = ['low', 'normal', 'high', 'critical'];
const FEEDBACK_CATEGORIES = [
    'bug' => ['app', 'messages', 'calls', 'notifications', 'interface', 'files', 'channels', 'premium', 'other'],
    'idea' => ['interface', 'chats', 'channels', 'calls', 'privacy', 'premium', 'performance', 'other'],
    'question' => ['account', 'privacy', 'premium', 'channels', 'other'],
];
const FEEDBACK_MAX_FILES = 5;
const FEEDBACK_FILE_BYTES = 10 * 1048576;
const FEEDBACK_FINAL = ['closed', 'rejected'];

function feedbackFiles(mixed $value, int $userId): array
{
    if ($value === null) return [];
    if (!is_array($value) || !array_is_list($value) || count($value) > FEEDBACK_MAX_FILES) throw new ApiError('feedback_files_limit');
    $ids = array_values(array_unique(array_map(fn($id) => intValue($id), $value)));
    if (!$ids) return [];
    $rows = query("SELECT * FROM files WHERE id IN (" . placeholders($ids) . ") AND owner_id=? AND purpose='feedback' AND NOT EXISTS(SELECT 1 FROM feedback_files ff WHERE ff.file_id=files.id)", array_merge($ids, [$userId]))->fetchAll();
    if (count($rows) !== count($ids)) throw new ApiError('file_not_found', 404);
    return $ids;
}

function feedbackTechInfo(mixed $value): ?array
{
    if (!is_array($value)) return null;
    $allowed = ['app_version' => 40, 'user_agent' => 300, 'platform' => 60, 'language' => 20, 'viewport' => 30, 'screen' => 30, 'standalone' => 5, 'theme' => 20, 'online' => 5, 'page' => 40, 'timezone' => 60];
    $result = [];
    foreach ($allowed as $key => $max) {
        if (!array_key_exists($key, $value)) continue;
        $item = $value[$key];
        if (is_bool($item)) $item = $item ? 'true' : 'false';
        if (!is_string($item) && !is_int($item)) continue;
        $result[$key] = mb_substr(preg_replace('/[\x00-\x1F\x7F]/u', '', (string)$item), 0, $max);
    }
    return $result ?: null;
}

function feedbackTicketObject(array $row, bool $staff): array
{
    $result = [
        'id' => (int)$row['id'], 'type' => $row['type'], 'category' => $row['category'], 'title' => $row['title'], 'description' => $row['description'],
        'status' => $row['status'], 'created_at' => (int)$row['created_at'], 'updated_at' => (int)$row['updated_at'], 'closed_at' => $row['closed_at'] !== null ? (int)$row['closed_at'] : null,
        'unread' => (bool)($staff ? $row['staff_unread'] : $row['user_unread']),
        'can_reply' => $staff || !in_array($row['status'], FEEDBACK_FINAL, true),
        'last_message' => isset($row['last_body']) && $row['last_body'] !== null ? ['body' => mb_substr($row['last_body'], 0, 160), 'staff' => (bool)$row['last_staff'], 'created_at' => (int)$row['last_at']] : null,
    ];
    if ($staff) {
        $result['priority'] = $row['priority'];
        $result['tech_info'] = $row['tech_info'] !== null ? json_decode($row['tech_info'], true) : null;
        $result['user'] = isset($row['author_username']) ? ['id' => (int)$row['user_id'], 'name' => $row['author_name'], 'username' => $row['author_username']] : null;
        $result['message_count'] = (int)($row['message_count'] ?? 0);
    }
    return $result;
}

function feedbackThread(int $ticketId, bool $staff): array
{
    $messages = query('SELECT m.*,u.name AS author_name FROM feedback_messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.ticket_id=? ' . ($staff ? '' : 'AND m.internal=false AND m.kind<>\'priority\' ') . 'ORDER BY m.id', [$ticketId])->fetchAll();
    $files = [];
    foreach (query('SELECT ff.message_id,f.* FROM feedback_files ff JOIN files f ON f.id=ff.file_id WHERE ff.ticket_id=? ORDER BY f.id', [$ticketId])->fetchAll() as $row) $files[(int)($row['message_id'] ?? 0)][] = fileObject($row);
    return [
        'attachments' => $files[0] ?? [],
        'messages' => array_map(fn($row) => [
            'id' => (int)$row['id'], 'kind' => $row['kind'], 'body' => $row['body'], 'staff' => (bool)$row['staff'], 'internal' => (bool)$row['internal'],
            // Staff identity is shown as the team for users; staff sees the author.
            'author_name' => $row['staff'] && !$staff ? null : $row['author_name'], 'created_at' => (int)$row['created_at'], 'files' => $files[(int)$row['id']] ?? [],
        ], $messages),
    ];
}

function feedbackNotify(array $ticket, int $messageId, string $reason): void
{
    query("INSERT INTO notification_events(user_id,kind,feedback_ticket_id,dedup_key,created_at) VALUES(?,'feedback',?,?,?) ON CONFLICT DO NOTHING", [$ticket['user_id'], $ticket['id'], 'feedback:' . $reason . ':' . $messageId, time()]);
    $eventId = (int)query('SELECT id FROM notification_events WHERE user_id=? AND dedup_key=?', [$ticket['user_id'], 'feedback:' . $reason . ':' . $messageId])->fetchColumn();
    query('INSERT INTO push_deliveries(event_id,subscription_id,available_at) SELECT ?,id,? FROM push_subscriptions WHERE user_id=? AND expires_at>? ON CONFLICT DO NOTHING', [$eventId, time() + 2, $ticket['user_id'], time()]);
}

function feedbackMessage(int $ticketId, int $authorId, bool $staff, string $body, array $files = [], bool $internal = false, string $kind = 'message'): int
{
    $id = insertId('INSERT INTO feedback_messages(ticket_id,author_id,staff,internal,kind,body,created_at) VALUES(?,?,?,?,?,?,?)', [$ticketId, $authorId, $staff ? 'true' : 'false', $internal ? 'true' : 'false', $kind, $body, time()]);
    foreach ($files as $fileId) query('INSERT INTO feedback_files(ticket_id,message_id,file_id) VALUES(?,?,?)', [$ticketId, $id, $fileId]);
    return $id;
}

function feedbackHandle(string $action, array $input, array $user): array
{
    $userId = (int)$user['id'];
    $staff = str_starts_with($action, 'admin.');
    if ($staff) requireAdmin($user);
    switch ($action) {
        case 'feedback.create':
            rateLimit('feedback_hour', 5, 3600, (string)$userId);
            rateLimit('feedback_day', 15, 86400, (string)$userId);
            $type = $input['type'] ?? '';
            if (!isset(FEEDBACK_CATEGORIES[$type])) throw new ApiError('invalid_feedback');
            $category = $input['category'] ?? '';
            if (!in_array($category, FEEDBACK_CATEGORIES[$type], true)) throw new ApiError('invalid_feedback');
            $title = textValue($input['title'] ?? '', 120, 3);
            $description = textValue($input['description'] ?? '', 5000, 10);
            $files = feedbackFiles($input['file_ids'] ?? null, $userId);
            $tech = ($input['tech_consent'] ?? false) === true ? feedbackTechInfo($input['tech_info'] ?? null) : null;
            if ((int)query("SELECT COUNT(*) FROM feedback_tickets WHERE user_id=? AND status NOT IN ('closed','rejected','fixed')", [$userId])->fetchColumn() >= 10) throw new ApiError('feedback_open_limit', 429);
            $id = transaction(function () use ($userId, $type, $category, $title, $description, $tech, $files): int {
                $id = insertId('INSERT INTO feedback_tickets(user_id,type,category,title,description,tech_info,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [$userId, $type, $category, $title, $description, $tech ? json_encode($tech, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) : null, time(), time()]);
                foreach ($files as $fileId) query('INSERT INTO feedback_files(ticket_id,file_id) VALUES(?,?)', [$id, $fileId]);
                return $id;
            });
            return feedbackHandle('feedback.get', ['ticket_id' => $id], $user);
        case 'feedback.list':
        case 'admin.feedback.list':
            $status = $input['status'] ?? 'all';
            if ($status !== 'all' && $status !== 'open' && !in_array($status, FEEDBACK_STATUSES, true)) throw new ApiError('invalid_feedback');
            $where = [];
            $params = [];
            if (!$staff) { $where[] = 't.user_id=?'; $params[] = $userId; }
            if ($status === 'open') $where[] = "t.status NOT IN ('closed','rejected','fixed')";
            elseif ($status !== 'all') { $where[] = 't.status=?'; $params[] = $status; }
            if ($staff) {
                if (!empty($input['type'])) { if (!isset(FEEDBACK_CATEGORIES[$input['type']])) throw new ApiError('invalid_feedback'); $where[] = 't.type=?'; $params[] = $input['type']; }
                if (!empty($input['priority'])) { if (!in_array($input['priority'], FEEDBACK_PRIORITIES, true)) throw new ApiError('invalid_feedback'); $where[] = 't.priority=?'; $params[] = $input['priority']; }
                $q = textValue($input['q'] ?? '', 100);
                if ($q !== '') {
                    if (preg_match('/^#?(\d{1,12})$/', $q, $match)) { $where[] = 't.id=?'; $params[] = (int)$match[1]; }
                    else { $where[] = '(t.title ILIKE ? OR t.description ILIKE ? OR u.username ILIKE ?)'; array_push($params, '%' . likeEscape($q) . '%', '%' . likeEscape($q) . '%', '%' . likeEscape($q) . '%'); }
                }
            }
            $sort = match ($input['sort'] ?? 'date') {
                'status' => "array_position(ARRAY['new','need_info','review','in_progress','fixed','closed','rejected'],t.status),t.updated_at DESC",
                'priority' => "array_position(ARRAY['critical','high','normal','low'],t.priority),t.updated_at DESC",
                'oldest' => 't.created_at ASC',
                default => 't.updated_at DESC',
            };
            $offset = min(intValue($input['offset'] ?? 0, 0), 100000);
            $rows = query('SELECT t.*,u.name AS author_name,u.username AS author_username,l.body AS last_body,l.staff AS last_staff,l.created_at AS last_at,(SELECT COUNT(*) FROM feedback_messages x WHERE x.ticket_id=t.id) AS message_count FROM feedback_tickets t JOIN users u ON u.id=t.user_id LEFT JOIN LATERAL (SELECT body,staff,created_at FROM feedback_messages m WHERE m.ticket_id=t.id AND m.kind=\'message\'' . ($staff ? '' : ' AND m.internal=false') . ' ORDER BY m.id DESC LIMIT 1) l ON true' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY ' . $sort . ' LIMIT 51 OFFSET ' . $offset, $params)->fetchAll();
            $result = ['tickets' => array_map(fn($row) => feedbackTicketObject($row, $staff), array_slice($rows, 0, 50)), 'has_more' => count($rows) > 50];
            if ($staff) {
                $result['counts'] = array_fill_keys(FEEDBACK_STATUSES, 0) + ['ideas' => 0, 'total' => 0, 'unread' => 0];
                foreach (query('SELECT status,COUNT(*) AS count FROM feedback_tickets GROUP BY status')->fetchAll() as $row) $result['counts'][$row['status']] = (int)$row['count'];
                $result['counts']['ideas'] = (int)query("SELECT COUNT(*) FROM feedback_tickets WHERE type='idea'")->fetchColumn();
                $result['counts']['unread'] = (int)query('SELECT COUNT(*) FROM feedback_tickets WHERE staff_unread')->fetchColumn();
                $result['counts']['total'] = array_sum(array_intersect_key($result['counts'], array_flip(FEEDBACK_STATUSES)));
            } else {
                $result['unread'] = (int)query('SELECT COUNT(*) FROM feedback_tickets WHERE user_id=? AND user_unread', [$userId])->fetchColumn();
            }
            return $result;
        case 'feedback.get':
        case 'admin.feedback.get':
            $ticket = feedbackTicketFor($input, $userId, $staff);
            query('UPDATE feedback_tickets SET ' . ($staff ? 'staff_unread' : 'user_unread') . '=false WHERE id=?', [$ticket['id']]);
            $ticket[$staff ? 'staff_unread' : 'user_unread'] = false;
            if ($staff) $ticket += query('SELECT name AS author_name,username AS author_username FROM users WHERE id=?', [$ticket['user_id']])->fetch();
            return ['ticket' => feedbackTicketObject($ticket, $staff)] + feedbackThread((int)$ticket['id'], $staff);
        case 'feedback.reply':
            rateLimit('feedback_reply', 30, 3600, (string)$userId);
            $ticket = feedbackTicketFor($input, $userId, false);
            if (in_array($ticket['status'], FEEDBACK_FINAL, true)) throw new ApiError('feedback_closed', 409);
            $body = textValue($input['body'] ?? '', 5000, 1);
            $files = feedbackFiles($input['file_ids'] ?? null, $userId);
            transaction(function () use ($ticket, $userId, $body, $files): void {
                feedbackMessage((int)$ticket['id'], $userId, false, $body, $files);
                $status = $ticket['status'] === 'need_info' ? 'review' : $ticket['status'];
                query('UPDATE feedback_tickets SET status=?,staff_unread=true,updated_at=? WHERE id=?', [$status, time(), $ticket['id']]);
                if ($status !== $ticket['status']) feedbackMessage((int)$ticket['id'], $userId, false, $status, [], false, 'status');
            });
            return feedbackHandle('feedback.get', ['ticket_id' => $ticket['id']], $user);
        case 'admin.feedback.reply':
            $ticket = feedbackTicketFor($input, $userId, true);
            $body = textValue($input['body'] ?? '', 5000, 1);
            $internal = ($input['internal'] ?? false) === true;
            $requestInfo = !$internal && ($input['request_info'] ?? false) === true;
            $files = feedbackFiles($input['file_ids'] ?? null, $userId);
            transaction(function () use ($ticket, $userId, $body, $internal, $requestInfo, $files): void {
                $messageId = feedbackMessage((int)$ticket['id'], $userId, true, $body, $files, $internal);
                if ($internal) { query('UPDATE feedback_tickets SET updated_at=? WHERE id=?', [time(), $ticket['id']]); return; }
                $status = $requestInfo ? 'need_info' : ($ticket['status'] === 'new' ? 'review' : $ticket['status']);
                query('UPDATE feedback_tickets SET status=?,user_unread=true,updated_at=?,closed_at=CASE WHEN ? IN (\'closed\',\'rejected\') THEN COALESCE(closed_at,?) ELSE NULL END WHERE id=?', [$status, time(), $status, time(), $ticket['id']]);
                if ($status !== $ticket['status']) feedbackMessage((int)$ticket['id'], $userId, true, $status, [], false, 'status');
                feedbackNotify($ticket, $messageId, $requestInfo ? 'need_info' : 'reply');
                adminAudit($userId, 'feedback.reply', (int)$ticket['user_id'], ['request_info' => $requestInfo], 'feedback', (int)$ticket['id']);
            });
            return feedbackHandle('admin.feedback.get', ['ticket_id' => $ticket['id']], $user);
        case 'admin.feedback.update':
            $ticket = feedbackTicketFor($input, $userId, true);
            $status = $input['status'] ?? $ticket['status'];
            $priority = $input['priority'] ?? $ticket['priority'];
            if (!in_array($status, FEEDBACK_STATUSES, true) || !in_array($priority, FEEDBACK_PRIORITIES, true)) throw new ApiError('invalid_feedback');
            transaction(function () use ($ticket, $userId, $status, $priority): void {
                query('UPDATE feedback_tickets SET status=?,priority=?,updated_at=?,user_unread=user_unread OR ?::boolean,closed_at=CASE WHEN ? IN (\'closed\',\'rejected\') THEN COALESCE(closed_at,?) ELSE NULL END WHERE id=?', [$status, $priority, time(), $status !== $ticket['status'] ? 'true' : 'false', $status, time(), $ticket['id']]);
                if ($priority !== $ticket['priority']) feedbackMessage((int)$ticket['id'], $userId, true, $priority, [], true, 'priority');
                if ($status !== $ticket['status']) {
                    $messageId = feedbackMessage((int)$ticket['id'], $userId, true, $status, [], false, 'status');
                    feedbackNotify($ticket, $messageId, 'status');
                }
                adminAudit($userId, 'feedback.update', (int)$ticket['user_id'], ['status' => [$ticket['status'], $status], 'priority' => [$ticket['priority'], $priority]], 'feedback', (int)$ticket['id']);
            });
            return feedbackHandle('admin.feedback.get', ['ticket_id' => $ticket['id']], $user);
    }
    throw new ApiError('invalid_action', 404);
}

/** Users only ever load their own tickets; foreign IDs look the same as missing ones. */
function feedbackTicketFor(array $input, int $userId, bool $staff): array
{
    $id = intValue($input['ticket_id'] ?? null);
    $ticket = $staff
        ? query('SELECT * FROM feedback_tickets WHERE id=?', [$id])->fetch()
        : query('SELECT * FROM feedback_tickets WHERE id=? AND user_id=?', [$id, $userId])->fetch();
    if (!$ticket) throw new ApiError('feedback_not_found', 404);
    return $ticket;
}
