<?php
declare(strict_types=1);

// PingUp Premium: dated subscription records with source and audit. Not related to the admin role.

const PREMIUM_THEMES = ['aurora', 'midnight_glass', 'neon_pulse', 'purple_galaxy', 'cyber_blue', 'emerald', 'golden_night', 'liquid_gradient'];
const FREE_THEMES = ['pingup', 'ocean', 'sunset', 'forest', 'graphite'];
const PREMIUM_WALLPAPERS = ['stardust', 'aurora_flow', 'neon_grid', 'liquid'];
const FREE_WALLPAPERS = ['none', 'dots', 'waves', 'grid', 'soft'];
const FREE_ACCENTS = ['#a78bfa', '#60a5fa', '#f472b6', '#34d399', '#f59e0b', '#ef4444', '#22d3ee', '#94a3b8'];
const PREMIUM_ACCENTS = ['#e879f9', '#fbbf24', '#2dd4bf', '#fb7185', '#818cf8', '#a3e635'];
const PROFILE_EFFECTS = ['none', 'glow', 'sparkle', 'aurora', 'neon'];
const PREMIUM_DURATIONS = [7, 30, 90, 365];

final class PremiumCache
{
    public static array $active = [];
}

function premiumPrefetch(array $userIds): void
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $userIds), fn(int $id) => !array_key_exists($id, PremiumCache::$active))));
    if (!$ids) return;
    foreach ($ids as $id) PremiumCache::$active[$id] = false;
    foreach (query("SELECT DISTINCT user_id FROM subscriptions WHERE status='active' AND starts_at<=? AND (ends_at IS NULL OR ends_at>?) AND user_id IN (" . placeholders($ids) . ')', array_merge([time(), time()], $ids))->fetchAll() as $row) {
        PremiumCache::$active[(int)$row['user_id']] = true;
    }
}

function premiumActive(int $userId): bool
{
    premiumPrefetch([$userId]);
    return PremiumCache::$active[$userId];
}

function premiumInfo(int $userId): array
{
    $now = time();
    $rows = query("SELECT * FROM subscriptions WHERE user_id=? AND status='active' AND (ends_at IS NULL OR ends_at>?) ORDER BY starts_at", [$userId, $now])->fetchAll();
    $active = false;
    $ends = 0;
    $forever = false;
    $source = null;
    foreach ($rows as $row) {
        if ((int)$row['starts_at'] <= $now) $active = true;
        if ($row['ends_at'] === null) $forever = true;
        else $ends = max($ends, (int)$row['ends_at']);
        $source = $row['source'];
    }
    $last = query('SELECT ends_at,revoked_at FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 1', [$userId])->fetch();
    return [
        'active' => $active, 'forever' => $active && $forever, 'ends_at' => $active && !$forever ? $ends : null,
        'source' => $source, 'expired' => !$active && $last !== false,
        'payments_available' => false,
        'upload_limit' => uploadLimit($userId, $active),
    ];
}

function uploadLimit(int $userId, ?bool $premium = null): int
{
    $config = config();
    $free = (int)($config['max_upload_bytes'] ?? 50 * 1048576);
    $premiumLimit = (int)($config['premium_upload_bytes'] ?? 200 * 1048576);
    return ($premium ?? premiumActive($userId)) ? max($free, $premiumLimit) : $free;
}

function adminAudit(int $actor, string $action, ?int $targetUser, array $details = [], string $targetType = '', ?int $targetId = null): void
{
    query('INSERT INTO admin_audit(actor_id,action,target_user_id,target_type,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)', [$actor, $action, $targetUser, $targetType, $targetId, json_encode($details, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), time()]);
}

function requireAdmin(array $user): void
{
    if ($user['role'] !== 'admin') throw new ApiError('admin_only', 403);
}

function subscriptionObject(array $row): array
{
    $now = time();
    $state = $row['status'] === 'revoked' ? 'revoked' : ((int)$row['starts_at'] > $now ? 'scheduled' : ($row['ends_at'] !== null && (int)$row['ends_at'] <= $now ? 'expired' : 'active'));
    return [
        'id' => (int)$row['id'], 'plan' => $row['plan'], 'state' => $state, 'source' => $row['source'],
        'starts_at' => (int)$row['starts_at'], 'ends_at' => $row['ends_at'] !== null ? (int)$row['ends_at'] : null,
        'granted_by' => $row['granted_by'] !== null ? (int)$row['granted_by'] : null, 'granted_by_name' => $row['granted_by_name'] ?? null,
        'revoked_at' => $row['revoked_at'] !== null ? (int)$row['revoked_at'] : null, 'note' => $row['note'], 'created_at' => (int)$row['created_at'],
    ];
}

function premiumHandle(string $action, array $input, array $user): mixed
{
    $userId = (int)$user['id'];
    if ($action === 'premium.status') {
        return premiumInfo($userId) + ['history' => array_map('subscriptionObject', query('SELECT * FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 20', [$userId])->fetchAll())];
    }
    requireAdmin($user);
    rateLimit('admin', 240, 60, (string)$userId);
    if ($action === 'admin.users.search') {
        $q = textValue($input['q'] ?? '', 80);
        $rows = $q === ''
            ? query('SELECT * FROM users ORDER BY id DESC LIMIT 30')->fetchAll()
            : query("SELECT * FROM users WHERE username ILIKE ? OR name ILIKE ? OR lower(email)=lower(?) ORDER BY username LIMIT 30", ['%' . likeEscape($q) . '%', '%' . likeEscape($q) . '%', $q])->fetchAll();
        premiumPrefetch(array_column($rows, 'id'));
        return ['users' => array_map(fn($row) => normalizedUser($row, false, true) + ['premium_info' => premiumInfo((int)$row['id'])], $rows)];
    }
    $targetId = intValue($input['user_id'] ?? null);
    $target = query('SELECT * FROM users WHERE id=?', [$targetId])->fetch();
    if (!$target) throw new ApiError('user_not_found', 404);
    if ($action === 'admin.premium.history') {
        $subs = query('SELECT s.*,g.name AS granted_by_name FROM subscriptions s LEFT JOIN users g ON g.id=s.granted_by WHERE s.user_id=? ORDER BY s.id DESC LIMIT 100', [$targetId])->fetchAll();
        $audit = query("SELECT a.id,a.action,a.details,a.created_at,u.name AS actor_name FROM admin_audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.target_user_id=? AND a.action LIKE 'premium.%' ORDER BY a.id DESC LIMIT 100", [$targetId])->fetchAll();
        return [
            'user' => normalizedUser($target, false, true), 'premium' => premiumInfo($targetId),
            'subscriptions' => array_map('subscriptionObject', $subs),
            'audit' => array_map(fn($row) => ['id' => (int)$row['id'], 'action' => $row['action'], 'details' => json_decode($row['details'], true), 'actor_name' => $row['actor_name'], 'created_at' => (int)$row['created_at']], $audit),
        ];
    }
    if ($action === 'admin.premium.grant') {
        $days = $input['days'] ?? null;
        if ($days !== null && !in_array($days, PREMIUM_DURATIONS, true)) throw new ApiError('invalid_duration');
        $note = textValue($input['note'] ?? '', 300);
        transaction(function () use ($targetId, $days, $note, $userId): void {
            lockKey('premium:' . $targetId);
            $now = time();
            $current = query("SELECT bool_or(ends_at IS NULL) AS forever,MAX(ends_at) AS ends FROM subscriptions WHERE user_id=? AND status='active' AND (ends_at IS NULL OR ends_at>?)", [$targetId, $now])->fetch();
            if ($current['forever']) throw new ApiError('premium_already_forever', 409);
            // A grant during an active period extends it instead of overlapping.
            $start = max($now, (int)($current['ends'] ?? 0));
            $end = $days === null ? null : $start + $days * 86400;
            $id = insertId("INSERT INTO subscriptions(user_id,status,source,starts_at,ends_at,granted_by,note,created_at) VALUES(?,'active','admin',?,?,?,?,?)", [$targetId, $start, $end, $userId, $note, $now]);
            adminAudit($userId, $start > $now ? 'premium.extend' : 'premium.grant', $targetId, ['days' => $days, 'starts_at' => $start, 'ends_at' => $end, 'note' => $note], 'subscription', $id);
        });
    } elseif ($action === 'admin.premium.revoke') {
        $note = textValue($input['note'] ?? '', 300);
        transaction(function () use ($targetId, $userId, $note): void {
            lockKey('premium:' . $targetId);
            $ids = query("UPDATE subscriptions SET status='revoked',revoked_at=?,revoked_by=? WHERE user_id=? AND status='active' AND (ends_at IS NULL OR ends_at>?) RETURNING id", [time(), $userId, $targetId, time()])->fetchAll(PDO::FETCH_COLUMN);
            if (!$ids) throw new ApiError('premium_not_active', 409);
            adminAudit($userId, 'premium.revoke', $targetId, ['subscriptions' => array_map('intval', $ids), 'note' => $note], 'user', $targetId);
        });
    } else {
        throw new ApiError('invalid_action', 404);
    }
    PremiumCache::$active = [];
    return premiumHandle('admin.premium.history', ['user_id' => $targetId], $user);
}

function likeEscape(string $value): string
{
    return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $value);
}
