<?php
declare(strict_types=1);

// Privacy engine, contacts and blocks. Every check runs on the server; the client only renders results.

const PRIVACY_AUDIENCE_KEYS = ['online', 'last_seen', 'avatar', 'bio', 'profile', 'message_first', 'calls', 'group_invites', 'contact_requests', 'read_receipts', 'typing'];
const PRIVACY_AUDIENCES = ['everyone', 'contacts', 'nobody'];

final class PrivacyCache
{
    public static array $settings = [];
    public static array $contacts = [];
    public static array $blocks = [];
    public static ?int $viewer = null;

    public static function reset(): void
    {
        self::$settings = self::$contacts = self::$blocks = [];
    }
}

function viewerId(): ?int
{
    return PrivacyCache::$viewer;
}

function privacyDefaults(): array
{
    return array_fill_keys(PRIVACY_AUDIENCE_KEYS, 'everyone') + ['searchable' => true];
}

function pairKey(int $a, int $b): string
{
    return min($a, $b) . ':' . max($a, $b);
}

/** Loads settings, contact and block relations for many users with three queries. */
function privacyPrefetch(array $userIds, ?int $viewer = null): void
{
    $viewer ??= viewerId();
    $ids = array_values(array_unique(array_filter(array_map('intval', $userIds), fn(int $id) => !array_key_exists($id, PrivacyCache::$settings))));
    if ($ids) {
        foreach ($ids as $id) PrivacyCache::$settings[$id] = privacyDefaults();
        foreach (query('SELECT user_id,settings FROM privacy_settings WHERE user_id IN (' . placeholders($ids) . ')', $ids)->fetchAll() as $row) {
            PrivacyCache::$settings[(int)$row['user_id']] = array_replace(privacyDefaults(), json_decode($row['settings'], true) ?: []);
        }
    }
    if (!$viewer) return;
    $others = array_values(array_unique(array_filter(array_map('intval', $userIds), fn(int $id) => $id !== $viewer && !array_key_exists(pairKey($id, $viewer), PrivacyCache::$contacts))));
    if (!$others) return;
    foreach ($others as $id) {
        PrivacyCache::$contacts[pairKey($id, $viewer)] = null;
        PrivacyCache::$blocks[$viewer . '>' . $id] = false;
        PrivacyCache::$blocks[$id . '>' . $viewer] = false;
    }
    $in = placeholders($others);
    foreach (query("SELECT user_low,user_high,requested_by,status,updated_at FROM contacts WHERE (user_low=? AND user_high IN ($in)) OR (user_high=? AND user_low IN ($in))", array_merge([$viewer], $others, [$viewer], $others))->fetchAll() as $row) {
        PrivacyCache::$contacts[$row['user_low'] . ':' . $row['user_high']] = $row;
    }
    foreach (query("SELECT blocker_id,blocked_id FROM user_blocks WHERE (blocker_id=? AND blocked_id IN ($in)) OR (blocked_id=? AND blocker_id IN ($in))", array_merge([$viewer], $others, [$viewer], $others))->fetchAll() as $row) {
        PrivacyCache::$blocks[$row['blocker_id'] . '>' . $row['blocked_id']] = true;
    }
}

function privacySettings(int $userId): array
{
    if (!array_key_exists($userId, PrivacyCache::$settings)) privacyPrefetch([$userId], null);
    return PrivacyCache::$settings[$userId];
}

function contactRow(int $a, int $b): ?array
{
    $key = pairKey($a, $b);
    if (!array_key_exists($key, PrivacyCache::$contacts)) {
        $row = query('SELECT user_low,user_high,requested_by,status,updated_at FROM contacts WHERE user_low=? AND user_high=?', [min($a, $b), max($a, $b)])->fetch();
        PrivacyCache::$contacts[$key] = $row ?: null;
    }
    return PrivacyCache::$contacts[$key];
}

function areContacts(int $a, int $b): bool
{
    return $a !== $b && (contactRow($a, $b)['status'] ?? null) === 'accepted';
}

function isBlocked(int $blocker, int $blocked): bool
{
    $key = $blocker . '>' . $blocked;
    if (!array_key_exists($key, PrivacyCache::$blocks)) {
        PrivacyCache::$blocks[$key] = (bool)query('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?', [$blocker, $blocked])->fetchColumn();
    }
    return PrivacyCache::$blocks[$key];
}

function blockedEither(int $a, int $b): bool
{
    return isBlocked($a, $b) || isBlocked($b, $a);
}

/** True when $viewer may see/do $key on $owner. Blocking by the owner always denies. */
function privacyAllows(int $owner, ?int $viewer, string $key): bool
{
    if ($viewer === null) return false;
    if ($owner === $viewer) return true;
    if (isBlocked($owner, $viewer)) return false;
    $value = privacySettings($owner)[$key] ?? 'everyone';
    if ($key === 'searchable') return (bool)$value || areContacts($owner, $viewer);
    return match ($value) {
        'everyone' => true,
        'contacts' => areContacts($owner, $viewer),
        default => false,
    };
}

function sharesConversation(int $a, int $b): bool
{
    return (bool)query("SELECT 1 FROM conversation_members x JOIN conversation_members y ON y.conversation_id=x.conversation_id JOIN conversations c ON c.id=x.conversation_id WHERE x.user_id=? AND y.user_id=? AND c.type IN ('direct','group') LIMIT 1", [$a, $b])->fetchColumn();
}

/** Contact state as seen by $viewer. Never reveals that the other side blocked the viewer. */
function contactState(int $viewer, int $other): string
{
    if ($viewer === $other) return 'self';
    if (isBlocked($viewer, $other)) return 'blocked';
    $row = contactRow($viewer, $other);
    if (!$row || isBlocked($other, $viewer)) return 'none';
    if ($row['status'] === 'accepted') return 'accepted';
    if ($row['status'] === 'declined') return (int)$row['requested_by'] === $viewer ? 'declined' : 'none';
    return (int)$row['requested_by'] === $viewer ? 'outgoing' : 'incoming';
}

function privacyUpdate(array $input, int $userId): array
{
    return transaction(function () use ($input, $userId): array {
        lockKey('privacy:' . $userId);
        unset(PrivacyCache::$settings[$userId]);
        $settings = privacySettings($userId);
        foreach (PRIVACY_AUDIENCE_KEYS as $key) {
            if (!array_key_exists($key, $input)) continue;
            if (!in_array($input[$key], PRIVACY_AUDIENCES, true)) throw new ApiError('invalid_settings');
            $settings[$key] = $input[$key];
        }
        if (array_key_exists('searchable', $input)) {
            if (!is_bool($input['searchable'])) throw new ApiError('invalid_settings');
            $settings['searchable'] = $input['searchable'];
        }
        query('INSERT INTO privacy_settings(user_id,settings,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at', [$userId, json_encode($settings, JSON_THROW_ON_ERROR), time()]);
        PrivacyCache::$settings[$userId] = $settings;
        return $settings;
    });
}

function contactNotify(int $recipient, int $actor, string $kind): void
{
    $key = 'contact:' . $kind . ':' . $actor . ':' . time();
    query("INSERT INTO notification_events(user_id,kind,actor_id,dedup_key,created_at) VALUES(?,'contact',?,?,?) ON CONFLICT DO NOTHING", [$recipient, $actor, $key, time()]);
}

function contactsList(int $userId): array
{
    $rows = query("SELECT u.*,k.status,k.requested_by,k.updated_at AS contact_updated FROM contacts k JOIN users u ON u.id=CASE WHEN k.user_low=? THEN k.user_high ELSE k.user_low END WHERE (k.user_low=? OR k.user_high=?) AND k.status IN ('accepted','pending') ORDER BY u.name,u.id LIMIT 1000", [$userId, $userId, $userId])->fetchAll();
    $blocked = query('SELECT u.* FROM user_blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC LIMIT 500', [$userId])->fetchAll();
    privacyPrefetch(array_merge(array_column($rows, 'id'), array_column($blocked, 'id')), $userId);
    premiumPrefetch(array_column($rows, 'id'));
    $result = ['contacts' => [], 'incoming' => [], 'outgoing' => [], 'blocked' => []];
    foreach ($rows as $row) {
        if (isBlocked((int)$row['id'], $userId)) {
            if ($row['status'] === 'accepted') $result['contacts'][] = normalizedUser($row);
            continue;
        }
        $bucket = $row['status'] === 'accepted' ? 'contacts' : ((int)$row['requested_by'] === $userId ? 'outgoing' : 'incoming');
        $result[$bucket][] = normalizedUser($row);
    }
    $result['blocked'] = array_map(fn(array $row) => normalizedUser($row), $blocked);
    return $result;
}

function contactsHandle(string $action, array $input, array $user): array
{
    $userId = (int)$user['id'];
    if ($action === 'contacts.list') return contactsList($userId);
    rateLimit('contacts', 60, 3600, (string)$userId);
    $otherId = intValue($input['user_id'] ?? null);
    if ($otherId === $userId) throw new ApiError('invalid_contact');
    if (!query('SELECT 1 FROM users WHERE id=?', [$otherId])->fetchColumn()) throw new ApiError('user_not_found', 404);
    $low = min($userId, $otherId);
    $high = max($userId, $otherId);
    $now = time();
    transaction(function () use ($action, $input, $userId, $otherId, $low, $high, $now): void {
        lockKey('contact:' . $low . ':' . $high);
        PrivacyCache::reset();
        $row = query('SELECT * FROM contacts WHERE user_low=? AND user_high=? FOR UPDATE', [$low, $high])->fetch() ?: null;
        switch ($action) {
            case 'contacts.request':
                if (isBlocked($userId, $otherId)) throw new ApiError('contact_unblock_first', 409);
                // A blocked requester gets the same answer as a privacy refusal: no block disclosure.
                if (isBlocked($otherId, $userId)) throw new ApiError('contact_request_forbidden', 403);
                if ($row && $row['status'] === 'accepted') return;
                if ($row && $row['status'] === 'pending' && (int)$row['requested_by'] === $userId) return;
                if ($row && $row['status'] === 'pending') {
                    query("UPDATE contacts SET status='accepted',updated_at=? WHERE user_low=? AND user_high=?", [$now, $low, $high]);
                    contactNotify($otherId, $userId, 'accepted');
                    return;
                }
                if ($row && $row['status'] === 'declined' && (int)$row['requested_by'] === $userId && (int)$row['updated_at'] > $now - 7 * 86400) {
                    throw new ApiError('contact_request_cooldown', 429);
                }
                $audience = privacySettings($otherId)['contact_requests'] ?? 'everyone';
                if ($audience === 'nobody' || ($audience === 'contacts' && !sharesConversation($userId, $otherId))) {
                    throw new ApiError('contact_request_forbidden', 403);
                }
                rateLimit('contact_request', 30, 3600, (string)$userId);
                query("INSERT INTO contacts(user_low,user_high,requested_by,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(user_low,user_high) DO UPDATE SET requested_by=excluded.requested_by,status='pending',updated_at=excluded.updated_at", [$low, $high, $userId, $now, $now]);
                contactNotify($otherId, $userId, 'request');
                return;
            case 'contacts.respond':
                if (!$row || $row['status'] !== 'pending' || (int)$row['requested_by'] === $userId) throw new ApiError('contact_request_not_found', 404);
                $accept = ($input['accept'] ?? null) === true;
                query('UPDATE contacts SET status=?,updated_at=? WHERE user_low=? AND user_high=?', [$accept ? 'accepted' : 'declined', $now, $low, $high]);
                if ($accept) contactNotify($otherId, $userId, 'accepted');
                return;
            case 'contacts.cancel':
                if ($row && $row['status'] === 'pending' && (int)$row['requested_by'] === $userId) query('DELETE FROM contacts WHERE user_low=? AND user_high=?', [$low, $high]);
                return;
            case 'contacts.remove':
                if ($row) query('DELETE FROM contacts WHERE user_low=? AND user_high=?', [$low, $high]);
                return;
            case 'users.block':
                query('INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [$userId, $otherId, $now]);
                query('DELETE FROM contacts WHERE user_low=? AND user_high=?', [$low, $high]);
                query("UPDATE calls SET status='ended',ended_at=?,end_reason='rejected' WHERE status IN ('ringing','active') AND ((caller_id=? AND callee_id=?) OR (caller_id=? AND callee_id=?))", [$now, $userId, $otherId, $otherId, $userId]);
                return;
            case 'users.unblock':
                query('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?', [$userId, $otherId]);
                return;
        }
        throw new ApiError('invalid_action', 404);
    });
    PrivacyCache::reset();
    $other = query('SELECT * FROM users WHERE id=?', [$otherId])->fetch();
    return ['user' => profileFor($other, $userId), 'state' => contactState($userId, $otherId)];
}

/** Profile as visible to $viewer, with relationship metadata. */
function profileFor(array $profile, int $viewer): array
{
    $id = (int)$profile['id'];
    privacyPrefetch([$id], $viewer);
    $result = normalizedUser($profile, $id === $viewer);
    $result['contact_state'] = contactState($viewer, $id);
    $result['can_message'] = $id === $viewer || canStartDirect($viewer, $id);
    $result['can_call'] = $id !== $viewer && !blockedEither($viewer, $id) && privacyAllows($id, $viewer, 'calls');
    return $result;
}

/** Whether $viewer may open/create a direct chat with $target. Existing chats always stay usable unless blocked. */
function canStartDirect(int $viewer, int $target): bool
{
    if (blockedEither($viewer, $target)) return false;
    $key = 'direct:' . min($viewer, $target) . ':' . max($viewer, $target);
    if (query('SELECT 1 FROM conversations c WHERE c.direct_key=? AND EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id)', [$key])->fetchColumn()) return true;
    return privacyAllows($target, $viewer, 'message_first');
}

/** Profile lookups must not reveal hidden accounts to strangers. */
function profileVisible(array $profile, int $viewer): bool
{
    $id = (int)$profile['id'];
    if ($id === $viewer) return true;
    if (isBlocked($id, $viewer)) return sharesConversation($id, $viewer);
    if (privacyAllows($id, $viewer, 'searchable')) return true;
    return areContacts($id, $viewer) || contactRow($id, $viewer) !== null || sharesConversation($id, $viewer);
}
