<?php
declare(strict_types=1);

// Global search. People are never listed as a catalogue: a minimum query, rate limits and privacy apply.

const SEARCH_TYPES = ['all', 'people', 'channels', 'groups', 'messages', 'media', 'files'];

function searchPeople(string $q, int $viewer, int $limit = 20): array
{
    $handle = ltrim($q, '@');
    if (mb_strlen($handle) < 3 && !str_starts_with($q, '@')) return [];
    if (mb_strlen($handle) < 2) return [];
    // Usernames match by prefix (public identifier); display names only by word prefix to limit enumeration.
    $prefix = likeEscape(mb_strtolower($handle)) . '%';
    $word = '% ' . likeEscape($handle) . '%';
    $rows = query("SELECT u.* FROM users u LEFT JOIN privacy_settings ps ON ps.user_id=u.id WHERE u.id<>? AND (u.username LIKE ? OR (?::boolean AND (u.name ILIKE ? OR u.name ILIKE ?))) AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.blocker_id=u.id AND b.blocked_id=?) AND (COALESCE((ps.settings->>'searchable')::boolean,true) OR EXISTS(SELECT 1 FROM contacts k WHERE k.user_low=LEAST(u.id,?) AND k.user_high=GREATEST(u.id,?) AND k.status='accepted')) ORDER BY (u.username=?) DESC,(u.username LIKE ?) DESC,u.name,u.id LIMIT " . max(1, min(50, $limit)), [$viewer, $prefix, str_starts_with($q, '@') ? 'false' : 'true', likeEscape($handle) . '%', $word, $viewer, $viewer, $viewer, mb_strtolower($handle), $prefix])->fetchAll();
    privacyPrefetch(array_column($rows, 'id'), $viewer);
    premiumPrefetch(array_column($rows, 'id'));
    return array_map(fn($row) => normalizedUser($row) + ['contact_state' => contactState($viewer, (int)$row['id'])], $rows);
}

function searchMessages(string $q, int $viewer, string $type, ?int $conversationId, int $limit = 30): array
{
    $params = [$viewer];
    $where = 'cm.user_id=? AND m.deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id)';
    $join = '';
    if ($type === 'media' || $type === 'files') {
        $join = ' JOIN files f ON f.id=m.file_id OR EXISTS(SELECT 1 FROM message_files mf WHERE mf.message_id=m.id AND mf.file_id=f.id)';
        $where .= $type === 'media' ? " AND (f.mime LIKE 'image/%' OR f.mime LIKE 'video/%')" : " AND f.mime NOT LIKE 'image/%' AND f.mime NOT LIKE 'video/%' AND m.kind<>'voice'";
        if ($q !== '') { $where .= ' AND (m.text ILIKE ? OR f.original_name ILIKE ?)'; $params[] = '%' . likeEscape($q) . '%'; $params[] = '%' . likeEscape($q) . '%'; }
    } else {
        $where .= ' AND m.text ILIKE ?';
        $params[] = '%' . likeEscape($q) . '%';
    }
    if ($conversationId) { $where .= ' AND m.conversation_id=?'; $params[] = $conversationId; }
    $rows = query('SELECT DISTINCT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id' . $join . ' WHERE ' . $where . ' ORDER BY m.id DESC LIMIT ' . max(1, min(100, $limit)), $params)->fetchAll();
    return normalizedMessages($rows, $viewer);
}

// In-chat search for long histories: keyset pages (newest first), match count capped for speed, total visible messages.
const FIND_COUNT_CAP = 10000;
function conversationFind(array $input, int $viewer): array
{
    rateLimit('chat_find', 150, 60, (string)$viewer);
    $conversationId = intValue($input['conversation_id'] ?? null);
    conversationFor($conversationId, $viewer);
    $q = textValue($input['q'] ?? '', 100);
    $before = isset($input['before_id']) && $input['before_id'] !== '' ? intValue($input['before_id']) : null;
    $limit = max(1, min(50, (int)($input['limit'] ?? 30)));
    $visible = 'm.conversation_id=? AND m.deleted=0 AND m.thread_root_id IS NULL AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?)';
    $base = [$conversationId, $viewer];
    $totalMessages = (int)query("SELECT COUNT(*) FROM messages m WHERE $visible", $base)->fetchColumn();
    if (mb_strlen(trim($q)) < 1) return ['q' => $q, 'total_messages' => $totalMessages, 'total_matches' => 0, 'capped' => false, 'messages' => [], 'has_more' => false];
    $match = $visible . ' AND m.text ILIKE ?';
    $params = array_merge($base, ['%' . likeEscape($q) . '%']);
    $result = ['q' => $q, 'total_messages' => $totalMessages];
    if ($before === null) {
        $count = (int)query("SELECT COUNT(*) FROM (SELECT 1 FROM messages m WHERE $match LIMIT " . (FIND_COUNT_CAP + 1) . ') x', $params)->fetchColumn();
        $result['total_matches'] = min($count, FIND_COUNT_CAP);
        $result['capped'] = $count > FIND_COUNT_CAP;
    }
    $pageSql = $match . ($before !== null ? ' AND m.id<?' : '');
    $rows = query("SELECT m.* FROM messages m WHERE $pageSql ORDER BY m.id DESC LIMIT " . ($limit + 1), $before !== null ? array_merge($params, [$before]) : $params)->fetchAll();
    $result['has_more'] = count($rows) > $limit;
    $result['messages'] = normalizedMessages(array_slice($rows, 0, $limit), $viewer);
    return $result;
}

function searchHandle(array $input, array $user): array
{
    $viewer = (int)$user['id'];
    rateLimit('search_minute', 40, 60, (string)$viewer);
    rateLimit('search_hour', 600, 3600, (string)$viewer);
    $type = $input['type'] ?? 'all';
    if (!in_array($type, SEARCH_TYPES, true)) throw new ApiError('invalid_search_type');
    $q = textValue($input['q'] ?? '', 100);
    $conversationId = !empty($input['conversation_id']) ? intValue($input['conversation_id']) : null;
    if ($conversationId) conversationFor($conversationId, $viewer);
    $category = isset($input['category']) && $input['category'] !== '' ? $input['category'] : null;
    if ($category !== null && !in_array($category, COMMUNITY_CATEGORIES, true)) throw new ApiError('invalid_search_type');
    $minimum = (in_array($type, ['media', 'files'], true) && $conversationId) || ($category !== null && in_array($type, ['channels', 'groups'], true)) ? 0 : 2;
    if (mb_strlen($q) < $minimum) return ['q' => $q, 'type' => $type, 'too_short' => true, 'people' => [], 'channels' => [], 'groups' => [], 'messages' => [], 'media' => [], 'files' => []];
    $result = ['q' => $q, 'type' => $type, 'too_short' => false, 'people' => [], 'channels' => [], 'groups' => [], 'messages' => [], 'media' => [], 'files' => []];
    $all = $type === 'all';
    if (($all || $type === 'people') && !$conversationId) {
        rateLimit('people_search', 120, 3600, (string)$viewer);
        $result['people'] = searchPeople($q, $viewer, $all ? 8 : 30);
    }
    if (($all || $type === 'channels') && !$conversationId) $result['channels'] = communitySearch($q, $viewer, ['channel'], $all ? 6 : 30, $category);
    if (($all || $type === 'groups') && !$conversationId) $result['groups'] = communitySearch($q, $viewer, ['group'], $all ? 6 : 30, $category);
    if ($all || $type === 'messages') $result['messages'] = searchMessages($q, $viewer, 'messages', $conversationId, $all ? 15 : 50);
    if ($type === 'media') $result['media'] = searchMessages($q, $viewer, 'media', $conversationId, 60);
    if ($type === 'files') $result['files'] = searchMessages($q, $viewer, 'files', $conversationId, 60);
    return $result;
}
