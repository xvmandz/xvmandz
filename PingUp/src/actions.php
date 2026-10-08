<?php
declare(strict_types=1);
require_once __DIR__.'/Channels.php';
require_once __DIR__.'/Search.php';
require_once __DIR__.'/Mail.php';
require_once __DIR__.'/Feedback.php';
require_once __DIR__.'/Uploads.php';

const READ_ACTIONS = ['bootstrap', 'users.search', 'users.profile', 'channels.search', 'conversations.list', 'messages.list', 'messages.thread', 'messages.search', 'messages.starred', 'messages.scheduled', 'messages.reactors', 'polls.voters', 'sync', 'calls.poll', 'calls.history', 'notifications.list', 'notifications.resolve', 'push.status', 'search.global', 'contacts.list', 'privacy.get', 'premium.status', 'email.status', 'feedback.list', 'feedback.get', 'stickers.packs', 'folders.list', 'channels.members', 'channels.bans', 'channels.invites', 'channels.audit', 'channels.stats', 'admin.users.search', 'admin.premium.history', 'admin.feedback.list', 'admin.feedback.get'];
const WRITE_ACTIONS = ['auth.register', 'auth.login', 'auth.logout', 'auth.password', 'auth.recover_request', 'auth.recover_confirm', 'profile.update', 'channels.join', 'channels.leave', 'channels.update', 'channels.set_role', 'channels.ban', 'channels.unban', 'channels.invite_create', 'channels.invite_revoke', 'channels.transfer', 'channels.archive', 'channels.delete', 'channels.own_theme', 'conversations.create', 'conversations.read', 'conversations.pin', 'conversations.archive', 'conversations.draft', 'messages.send', 'messages.edit', 'messages.delete', 'messages.delete_many', 'messages.react', 'messages.pin', 'messages.forward', 'messages.forward_many', 'messages.save', 'messages.star', 'messages.scheduled_cancel', 'messages.scheduled_now', 'polls.vote', 'polls.close', 'typing.set', 'files.upload', 'files.upload_init', 'files.upload_chunk', 'files.upload_finish', 'files.upload_cancel', 'calls.start', 'calls.signal', 'calls.accept', 'calls.end', 'notifications.settings', 'notifications.chat', 'push.subscribe', 'push.unsubscribe', 'contacts.request', 'contacts.respond', 'contacts.cancel', 'contacts.remove', 'users.block', 'users.unblock', 'privacy.update', 'email.set', 'email.resend', 'email.verify', 'email.unlink_request', 'email.unlink_confirm', 'feedback.create', 'feedback.reply', 'stickers.pack_create', 'stickers.add', 'stickers.remove', 'stickers.pack_delete', 'stickers.install', 'stickers.uninstall', 'folders.save', 'folders.delete', 'admin.premium.grant', 'admin.premium.revoke', 'admin.feedback.reply', 'admin.feedback.update'];

function bootstrapData(?array $user): array
{
    $settings = config();
    $data = [
        'user' => $user ? normalizedUser($user, true) : null,
        'csrf' => $_SESSION['csrf'],
        'version' => PINGUP_VERSION,
        'config' => [
            'registration_enabled' => (bool)($settings['registration_enabled'] ?? true),
            'invite_required' => !empty($settings['invite_code']),
            'max_upload_bytes' => $user ? uploadLimit((int)$user['id']) : (int)($settings['max_upload_bytes'] ?? 52428800),
            'free_upload_bytes' => (int)($settings['max_upload_bytes'] ?? 52428800),
            'premium_upload_bytes' => max((int)($settings['max_upload_bytes'] ?? 52428800), (int)($settings['premium_upload_bytes'] ?? 209715200)),
            'chunk_bytes' => UPLOAD_CHUNK_BYTES,
            'upload_extensions' => array_keys(uploadFormats()),
            'recovery_enabled' => smtpConfigured(),
            'calling_enabled' => true,
            'ice_servers' => $user ? ($settings['ice_servers'] ?? [['urls' => 'stun:stun.l.google.com:19302']]) : [],
        ],
        'server_time' => time(),
    ];
    if ($user) {
        $userId = (int)$user['id'];
        $data['notification_settings_initialized'] = (bool)query('SELECT 1 FROM notification_settings WHERE user_id=?',[$userId])->fetchColumn();
        $data['notification_settings'] = effectiveSettings(notificationSettings($userId), $userId);
        $data['event_cursor'] = (int)query('SELECT COALESCE(MAX(id),0) FROM notification_events WHERE user_id=?',[$userId])->fetchColumn();
        $data['conversations'] = conversationsList($userId);
        markDelivered($userId, $data['conversations']);
        $contacts = contactsList($userId);
        $data['contacts'] = $contacts['contacts'];
        $data['contact_requests'] = count($contacts['incoming']);
        $data['privacy'] = privacySettings($userId);
        $data['premium'] = premiumInfo($userId);
        $data['folders'] = foldersList($userId);
        $data['feedback_unread'] = (int)query('SELECT COUNT(*) FROM feedback_tickets WHERE user_id=? AND user_unread', [$userId])->fetchColumn();
        if ($user['role'] === 'admin') $data['admin'] = ['feedback_unread' => (int)query('SELECT COUNT(*) FROM feedback_tickets WHERE staff_unread')->fetchColumn()];
    }
    return $data;
}

function authRegister(array $body): array
{
    rateLimit('register', 12, 3600);
    if (!(config()['registration_enabled'] ?? true)) {
        throw new ApiError('registration_disabled', 403);
    }
    $invite = (string)(config()['invite_code'] ?? '');
    if ($invite !== '' && (!is_string($body['invite_code'] ?? null) || !hash_equals($invite, $body['invite_code']))) {
        throw new ApiError('invite_invalid', 403);
    }
    $username = usernameValue($body['username'] ?? $body['identifier'] ?? '');
    $name = textValue($body['name'] ?? '', 60, 1);
    $password = passwordValue($body['password'] ?? '');
    $locale = $body['locale'] ?? 'uk';
    if (!in_array($locale, ['ru', 'uk', 'en'], true)) {
        throw new ApiError('invalid_locale');
    }
    $hash = passwordHash($password);
    $id = transaction(function () use ($username, $name, $hash, $locale): int {
        lockKey('registration');
        if (query('SELECT id FROM users WHERE username=?', [$username])->fetchColumn()) {
            throw new ApiError('username_taken', 409);
        }
        $maximum = (int)(config()['max_users'] ?? 0);
        if ($maximum > 0 && (int)query("SELECT COUNT(*) FROM users WHERE role='user'")->fetchColumn() >= $maximum) {
            throw new ApiError('user_limit', 403);
        }
        $id = insertId('INSERT INTO users(username,name,password_hash,locale,last_seen,created_at) VALUES(?,?,?,?,?,?)', [$username, $name, $hash, $locale, time(), time()]);
        savedConversation($id);
        return $id;
    });
    session_regenerate_id(true);
    $_SESSION['user_id'] = $id;
    $_SESSION['session_version'] = 1;
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    $_SESSION['last_activity'] = time();
    return bootstrapData(currentUser());
}

function authLogin(array $body): array
{
    rateLimit('login', 60, 900);
    $identifier = strtolower(trim((string)($body['username'] ?? $body['identifier'] ?? '')));
    // Sign-in by verified e-mail as well as by @username.
    $byEmail = str_contains($identifier, '@') && !str_starts_with($identifier, '@');
    $username = $byEmail ? emailValue($identifier) : usernameValue(ltrim($identifier, '@'));
    rateLimit('login_user', 12, 900, $username);
    $password = is_string($body['password'] ?? null) ? $body['password'] : '';
    if (strlen($password) > 128 || str_contains($password, "\0")) {
        throw new ApiError('invalid_credentials', 401);
    }
    $user = $byEmail
        ? query('SELECT * FROM users WHERE lower(email)=? AND email_verified_at IS NOT NULL', [$username])->fetch()
        : query('SELECT * FROM users WHERE username=?', [$username])->fetch();
    // Precomputed bcrypt fallback keeps unknown usernames on the password verification path.
    $fallback = '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';
    if (!password_verify($password, $user ? $user['password_hash'] : $fallback) || !$user) {
        throw new ApiError('invalid_credentials', 401);
    }
    $algorithm = defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT;
    if (password_needs_rehash($user['password_hash'], $algorithm)) {
        query('UPDATE users SET password_hash=? WHERE id=?', [passwordHash($password), $user['id']]);
    }
    session_regenerate_id(true);
    $_SESSION['user_id'] = (int)$user['id'];
    $_SESSION['session_version'] = (int)$user['session_version'];
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
    $_SESSION['last_activity'] = time();
    return bootstrapData(currentUser());
}

function profileUpdate(array $body, array $user): array
{
    $updates = [];
    $values = [];
    if (array_key_exists('username', $body)) {
        $username = usernameValue($body['username']);
        if (query('SELECT id FROM users WHERE username=? AND id<>?', [$username, $user['id']])->fetchColumn()) {
            throw new ApiError('username_taken', 409);
        }
        $updates[] = 'username=?';
        $values[] = $username;
    }
    foreach (['name' => 60, 'bio' => 300, 'location' => 80, 'website' => 200] as $field => $length) {
        if (array_key_exists($field, $body)) {
            $value = textValue($body[$field], $length, $field === 'name' ? 1 : 0);
            if ($field === 'website' && $value !== '') {
                $url = parse_url($value);
                if (!$url || !in_array(strtolower($url['scheme'] ?? ''), ['http', 'https'], true) || empty($url['host']) || isset($url['user']) || isset($url['pass']) || !filter_var($value, FILTER_VALIDATE_URL)) {
                    throw new ApiError('invalid_website');
                }
            }
            $updates[] = $field . '=?';
            $values[] = $value;
        }
    }
    foreach (['locale' => ['ru', 'uk', 'en'], 'theme' => ['dark', 'light', 'system']] as $field => $allowed) {
        if (array_key_exists($field, $body)) {
            if (!in_array($body[$field], $allowed, true)) {
                throw new ApiError('invalid_' . $field);
            }
            $updates[] = $field . '=?';
            $values[] = $body[$field];
        }
    }
    if (array_key_exists('accent', $body)) {
        $namedAccents = ['violet' => '#a78bfa', 'blue' => '#60a5fa', 'pink' => '#f472b6', 'mint' => '#34d399'];
        $accent = is_string($body['accent']) ? ($namedAccents[$body['accent']] ?? strtolower($body['accent'])) : null;
        // Profile colour stays free-form as in 2.0; Premium palettes apply to the interface accent setting.
        if (!is_string($accent) || !preg_match('/^#[a-f0-9]{6}$/', $accent)) {
            throw new ApiError('invalid_accent');
        }
        $updates[] = 'accent=?';
        $values[] = $accent;
    }
    if (array_key_exists('profile_effect', $body)) {
        if (!in_array($body['profile_effect'], PROFILE_EFFECTS, true)) throw new ApiError('invalid_settings');
        if ($body['profile_effect'] !== 'none' && !premiumActive((int)$user['id'])) throw new ApiError('premium_required', 402);
        $updates[] = 'profile_effect=?';
        $values[] = $body['profile_effect'];
    }
    if (array_key_exists('avatar_file_id', $body)) {
        $avatarId = $body['avatar_file_id'] === null ? null : intValue($body['avatar_file_id']);
        if ($avatarId !== null) {
            $file = query('SELECT * FROM files WHERE id=? AND owner_id=?', [$avatarId, $user['id']])->fetch();
            if (!$file || !in_array($file['mime'], ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'], true)) {
                throw new ApiError('invalid_avatar');
            }
        }
        $updates[] = 'avatar_file_id=?';
        $values[] = $avatarId;
    }
    if ($updates) {
        $values[] = $user['id'];
        try {
            query('UPDATE users SET ' . implode(',', $updates) . ' WHERE id=?', $values);
        } catch (PDOException $error) {
            if ($error->getCode()==='23505') {
                throw new ApiError('username_taken', 409);
            }
            throw $error;
        }
    }
    return normalizedUser(currentUser(), true);
}

function conversationsCreate(array $body, array $user): array
{
    rateLimit('conversation_create', 20, 60, (string)$user['id']);
    $type = $body['type'] ?? 'direct';
    if (!in_array($type, ['direct', 'group', 'channel'], true)) {
        throw new ApiError('invalid_conversation_type');
    }
    $userId = (int)$user['id'];
    if ($type === 'direct') {
        $other = intValue($body['user_id'] ?? null);
        if ($other === $userId) {
            $id = savedConversation($userId);
        } else {
            if (!query('SELECT id FROM users WHERE id=?', [$other])->fetchColumn()) {
                throw new ApiError('user_not_found', 404);
            }
            if (!canStartDirect($userId, $other)) {
                throw new ApiError(blockedEither($userId, $other) ? 'user_blocked' : 'privacy_restricted', 403);
            }
            $id = directConversation($userId, $other);
        }
    } else {
        $name = textValue($body['name'] ?? '', 80, 1);
        $description=textValue($body['description']??'',500);
        $slug=channelSlug($body['slug']??null);
        $visibility=$body['visibility']??'private';
        if(!in_array($visibility,['public','private'],true)||$visibility==='public'&&!$slug)throw new ApiError('invalid_channel_slug');
        $members = $body['user_ids'] ?? [];
        if (!is_array($members) || !array_is_list($members) || count($members) > 199) {
            throw new ApiError('invalid_members');
        }
        $settingsInput = $body['settings'] ?? [];
        if (!is_array($settingsInput)) throw new ApiError('invalid_settings');
        $settings = communitySettingsInput($settingsInput, communityDefaults(), $type);
        $id = transaction(function () use ($type, $name, $userId, $members,$description,$slug,$visibility,$user,$settings): int {
            try{$id = insertId('INSERT INTO conversations(type,name,owner_id,created_at,updated_at,description,slug,visibility,invite_token,settings) VALUES(?,?,?,?,?,?,?,?,?,?)', [$type, $name, $userId, time(), time(),$description,$slug,$visibility,bin2hex(random_bytes(24)),json_encode($settings,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE)]);}catch(PDOException $error){if($error->getCode()==='23505')throw new ApiError('channel_slug_taken',409);throw $error;}
            query("INSERT INTO conversation_members(conversation_id,user_id,role,joined_at) VALUES(?,?,'owner',?)", [$id, $userId, time()]);
            $conversation=query('SELECT * FROM conversations WHERE id=?',[$id])->fetch();
            addCommunityMembers($conversation, $members, $user);
            communityAudit($id,$userId,'community.create');
            return $id;
        });
    }
    return normalizedConversation(conversationFor($id, $userId), $userId);
}

function syncData(array $input, array $user): array
{
    $userId = (int)$user['id'];
    // Scheduled posts become due without a cron job too; the check is a single indexed probe.
    if (query("SELECT 1 FROM scheduled_messages WHERE status='scheduled' AND send_at<=? LIMIT 1", [time()])->fetchColumn()) publishDueScheduled(10);
    $events = notificationsList($input,$user);
    $conversations = conversationsList($userId);
    markDelivered($userId, $conversations);
    $data = ['events'=>$events['events'],'event_cursor'=>$events['event_cursor'],'notification_settings'=>$events['settings'],'conversations' => $conversations, 'messages' => [], 'updated_messages' => [], 'typing' => [], 'user' => normalizedUser($user, true), 'server_time' => time()];
    if (!empty($input['conversation_id'])) {
        $id = intValue($input['conversation_id']);
        conversationFor($id, $userId);
        $after = intValue($input['after_id'] ?? 0, 0);
        $new = query('SELECT * FROM messages WHERE conversation_id=? AND id>? AND thread_root_id IS NULL ORDER BY id ASC LIMIT 100', [$id, $after])->fetchAll();
        $change=intValue($input['after_change_seq']??0,0);
        $updates=query('SELECT * FROM messages WHERE conversation_id=? AND change_seq>? ORDER BY change_seq LIMIT 200',[$id,$change])->fetchAll();
        $data['messages']=normalizedMessages($new,$userId);
        $data['updated_messages']=normalizedMessages($updates,$userId);
        $data['change_cursor']=$updates?(int)max(array_column($updates,'change_seq')):$change;
        $typing = query('SELECT u.id,u.name,t.kind FROM typing t JOIN users u ON u.id=t.user_id WHERE t.conversation_id=? AND t.user_id<>? AND t.expires_at>?', [$id, $userId, time()])->fetchAll();
        privacyPrefetch(array_column($typing, 'id'), $userId);
        $data['typing'] = array_values(array_map(fn(array $row) => ['id' => (int)$row['id'], 'name' => $row['name'], 'kind' => $row['kind']], array_filter($typing, fn(array $row) => privacyAllows((int)$row['id'], $userId, 'typing'))));
    }
    return $data;
}

function foldersList(int $userId): array
{
    return array_map(fn($row) => ['id' => (int)$row['id'], 'name' => $row['name'], 'types' => json_decode($row['types'], true), 'conversation_ids' => json_decode($row['conversation_ids'], true), 'position' => (int)$row['position']], query('SELECT * FROM chat_folders WHERE user_id=? ORDER BY position,id', [$userId])->fetchAll());
}

function foldersHandle(string $action, array $input, int $userId): array
{
    if ($action === 'folders.save') {
        rateLimit('folders', 60, 3600, (string)$userId);
        $name = textValue($input['name'] ?? '', 24, 1);
        $types = $input['types'] ?? [];
        $ids = $input['conversation_ids'] ?? [];
        if (!is_array($types) || array_diff($types, ['direct', 'group', 'channel', 'unread', 'saved']) || !is_array($ids) || !array_is_list($ids) || count($ids) > 200) throw new ApiError('invalid_folder');
        $ids = array_values(array_unique(array_map(fn($id) => intValue($id), $ids)));
        if ($ids && (int)query('SELECT COUNT(*) FROM conversation_members WHERE user_id=? AND conversation_id IN (' . placeholders($ids) . ')', array_merge([$userId], $ids))->fetchColumn() !== count($ids)) throw new ApiError('invalid_folder');
        if (!$types && !$ids) throw new ApiError('invalid_folder');
        if (!empty($input['id'])) {
            if (!query('UPDATE chat_folders SET name=?,types=?,conversation_ids=? WHERE id=? AND user_id=? RETURNING id', [$name, json_encode(array_values(array_unique($types))), json_encode($ids), intValue($input['id']), $userId])->fetchColumn()) throw new ApiError('folder_not_found', 404);
        } else {
            if ((int)query('SELECT COUNT(*) FROM chat_folders WHERE user_id=?', [$userId])->fetchColumn() >= 10) throw new ApiError('folder_limit', 429);
            query('INSERT INTO chat_folders(user_id,name,position,types,conversation_ids,created_at) VALUES(?,?,(SELECT COALESCE(MAX(position)+1,0) FROM chat_folders WHERE user_id=?),?,?,?)', [$userId, $name, $userId, json_encode(array_values(array_unique($types))), json_encode($ids), time()]);
        }
    } elseif ($action === 'folders.delete') {
        query('DELETE FROM chat_folders WHERE id=? AND user_id=?', [intValue($input['id'] ?? null), $userId]);
    }
    return ['folders' => foldersList($userId)];
}

function dispatchAction(string $action, array $input): mixed
{
    if ($action === 'bootstrap') {
        return bootstrapData(currentUser(false));
    }
    if ($action === 'auth.register') {
        return authRegister($input);
    }
    if ($action === 'auth.login') {
        return authLogin($input);
    }
    if ($action === 'auth.recover_request') return authRecoverRequest($input);
    if ($action === 'auth.recover_confirm') return authRecoverConfirm($input);
    if ($action === 'auth.logout') {
        $id = (int)($_SESSION['user_id'] ?? 0);
        if ($id) {
            query('UPDATE users SET last_seen=? WHERE id=?', [time() - 91, $id]);
        }
        query('DELETE FROM push_subscriptions WHERE session_hash=?',[hash('sha256',session_id())]);
        $_SESSION = ['csrf' => bin2hex(random_bytes(32)), 'last_activity' => time()];
        session_regenerate_id(true);
        return bootstrapData(null);
    }
    $user = currentUser();
    $userId = (int)$user['id'];
    if (str_starts_with($action, 'notifications.') || str_starts_with($action, 'push.')) return notificationsHandle($action,$input,$user);
    if (str_starts_with($action, 'calls.')) {
        return callsHandle($action, $input, $_GET, $userId);
    }
    if (str_starts_with($action, 'messages.') || str_starts_with($action, 'polls.')) {
        if ($action === 'messages.search') return searchHandle(['type' => 'messages'] + $input, $user)['messages'];
        return messagesHandle($action, $input, $user);
    }
    if (str_starts_with($action, 'contacts.') || $action === 'users.block' || $action === 'users.unblock') return contactsHandle($action, $input, $user);
    if (str_starts_with($action, 'channels.')) return channelsHandle($action, $input, $user);
    if (str_starts_with($action, 'stickers.')) return stickersHandle($action, $input, $user);
    if (str_starts_with($action, 'files.')) return uploadsHandle($action, $input, $user);
    if (str_starts_with($action, 'email.')) return emailHandle($action, $input, $user);
    if (str_starts_with($action, 'feedback.') || str_starts_with($action, 'admin.feedback.')) return feedbackHandle($action, $input, $user);
    if (str_starts_with($action, 'premium.') || str_starts_with($action, 'admin.')) return premiumHandle($action, $input, $user);
    if (str_starts_with($action, 'folders.')) return foldersHandle($action, $input, $userId);
    switch ($action) {
        case 'auth.password':
            rateLimit('password_change', 8, 900, (string)$userId);
            $currentPassword = passwordValue($input['current_password'] ?? '');
            $newPassword = passwordValue($input['new_password'] ?? '');
            if (!password_verify($currentPassword, $user['password_hash'])) {
                throw new ApiError('current_password_invalid', 400);
            }
            $newHash = passwordHash($newPassword);
            transaction(function () use ($userId, $currentPassword, $newHash): void {
                $latest = query('SELECT * FROM users WHERE id=?', [$userId])->fetch();
                if (!$latest || !password_verify($currentPassword, $latest['password_hash'])) {
                    throw new ApiError('current_password_invalid', 400);
                }
                query('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=?', [$newHash, $userId]);
            });
            emailNotice($user, 'password_changed');
            $_SESSION['session_version'] = (int)query('SELECT session_version FROM users WHERE id=?', [$userId])->fetchColumn();
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
            session_regenerate_id(true);
            return ['user' => normalizedUser(currentUser(), true), 'csrf' => $_SESSION['csrf']];
        case 'profile.update':
            rateLimit('profile', 30, 60, (string)$userId);
            return profileUpdate($input, $user);
        case 'privacy.get':
            return privacySettings($userId);
        case 'privacy.update':
            rateLimit('privacy', 60, 60, (string)$userId);
            return privacyUpdate($input, $userId);
        case 'search.global':
            return searchHandle($input, $user);
        case 'users.search':
            // Kept for 2.0 clients: same privacy rules and minimum length as global search.
            rateLimit('user_search', 40, 60, (string)$userId);
            return searchPeople(textValue($input['q'] ?? '', 80), $userId, 30);
        case 'users.profile':
            rateLimit('profile_view', 120, 60, (string)$userId);
            $profile = query('SELECT * FROM users WHERE id=?', [intValue($input['user_id'] ?? null)])->fetch();
            if (!$profile) {
                throw new ApiError('user_not_found', 404);
            }
            privacyPrefetch([(int)$profile['id']], $userId);
            if (!profileVisible($profile, $userId)) throw new ApiError('user_not_found', 404);
            return profileFor($profile, $userId);
        case 'conversations.list':
            return conversationsList($userId);
        case 'conversations.create':
            return conversationsCreate($input, $user);
        case 'conversations.read':
            $id = intValue($input['conversation_id'] ?? null);
            $conversation = conversationFor($id, $userId);
            $messageId = intValue($input['last_message_id'] ?? 0, 0);
            if ($messageId) {
                $message = messageFor($messageId, $userId, true);
                if ((int)$message['conversation_id'] !== $id) {
                    throw new ApiError('message_not_found', 404);
                }
            }
            transaction(function () use ($id, $userId, $messageId, $conversation): void {
                $previous = (int)query('SELECT last_read_message_id FROM conversation_members WHERE conversation_id=? AND user_id=? FOR UPDATE', [$id, $userId])->fetchColumn();
                if ($messageId <= $previous) return;
                query('UPDATE conversation_members SET last_read_message_id=?,last_delivered_message_id=GREATEST(last_delivered_message_id,?) WHERE conversation_id=? AND user_id=?', [$messageId, $messageId, $id, $userId]);
                if ($conversation['type'] === 'channel') {
                    // Aggregate view counters only: who viewed is never stored.
                    $viewed = query('INSERT INTO message_views(message_id,views) SELECT id,1 FROM messages WHERE conversation_id=? AND id>? AND id<=? AND thread_root_id IS NULL AND deleted=0 AND sender_id<>? ON CONFLICT(message_id) DO UPDATE SET views=message_views.views+1 RETURNING message_id', [$id, $previous, $messageId, $userId])->rowCount();
                    statsBump($id, 'views', $viewed);
                }
            });
            return normalizedConversation(conversationFor($id, $userId), $userId);
        case 'conversations.pin':
            $id = intValue($input['conversation_id'] ?? null);
            conversationFor($id, $userId);
            query('UPDATE conversation_members SET pinned=? WHERE conversation_id=? AND user_id=?', [!empty($input['pinned']) ? 1 : 0, $id, $userId]);
            return normalizedConversation(conversationFor($id, $userId), $userId);
        case 'conversations.archive':
            $id = intValue($input['conversation_id'] ?? null);
            conversationFor($id, $userId);
            query('UPDATE conversation_members SET archived=?,pinned=CASE WHEN ? THEN 0 ELSE pinned END WHERE conversation_id=? AND user_id=?', [!empty($input['archived']) ? 1 : 0, !empty($input['archived']) ? 'true' : 'false', $id, $userId]);
            return normalizedConversation(conversationFor($id, $userId), $userId);
        case 'conversations.draft':
            rateLimit('draft', 240, 60, (string)$userId);
            $id = intValue($input['conversation_id'] ?? null);
            conversationFor($id, $userId);
            query('UPDATE conversation_members SET draft=?,draft_updated_at=? WHERE conversation_id=? AND user_id=?', [textValue($input['text'] ?? '', 10000), time(), $id, $userId]);
            return ['saved' => true, 'draft_updated_at' => time()];
        case 'typing.set':
            rateLimit('typing', 60, 60, (string)$userId);
            $id = intValue($input['conversation_id'] ?? null);
            $conversation = conversationFor($id, $userId);
            if (!memberCan($conversation, $user, 'post') && !communitySettings($conversation)['comments_enabled']) throw new ApiError('posting_forbidden', 403);
            $kind = $input['kind'] ?? 'typing';
            if (!in_array($kind, ['typing', 'recording', 'uploading'], true)) throw new ApiError('invalid_settings');
            if (($input['typing'] ?? true) === false) {
                query('DELETE FROM typing WHERE conversation_id=? AND user_id=?', [$id, $userId]);
            } else {
                query('INSERT INTO typing(conversation_id,user_id,expires_at,kind) VALUES(?,?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET expires_at=excluded.expires_at,kind=excluded.kind', [$id, $userId, time() + 7, $kind]);
            }
            return ['typing' => true];
        case 'sync':
            return syncData($input, $user);
    }
    throw new ApiError('invalid_action', 404);
}
