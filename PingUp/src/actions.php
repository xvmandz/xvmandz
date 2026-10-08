<?php
declare(strict_types=1);
require_once __DIR__.'/Channels.php';

function bootstrapData(?array $user): array
{
    $settings = config();
    $data = [
        'user' => $user ? normalizedUser($user, true) : null,
        'csrf' => $_SESSION['csrf'],
        'config' => [
            'registration_enabled' => (bool)($settings['registration_enabled'] ?? true),
            'invite_required' => !empty($settings['invite_code']),
            'max_upload_bytes' => (int)($settings['max_upload_bytes'] ?? 10485760),
            'calling_enabled' => true,
            'ice_servers' => $user ? ($settings['ice_servers'] ?? [['urls' => 'stun:stun.l.google.com:19302']]) : [],
        ],
        'server_time' => time(),
    ];
    if ($user) {
        $data['notification_settings_initialized'] = (bool)query('SELECT 1 FROM notification_settings WHERE user_id=?',[$user['id']])->fetchColumn();
        $data['notification_settings'] = notificationSettings((int)$user['id']);
        $data['event_cursor'] = (int)query('SELECT COALESCE(MAX(id),0) FROM notification_events WHERE user_id=?',[$user['id']])->fetchColumn();
        $data['conversations'] = conversationsList((int)$user['id']);
        $data['contacts'] = array_map(fn(array $contact) => normalizedUser($contact), query('SELECT * FROM users WHERE id<>? ORDER BY name LIMIT 100', [$user['id']])->fetchAll());
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
    $username = usernameValue($body['username'] ?? $body['identifier'] ?? '');
    rateLimit('login_user', 12, 900, $username);
    $password = is_string($body['password'] ?? null) ? $body['password'] : '';
    if (strlen($password) > 128 || str_contains($password, "\0")) {
        throw new ApiError('invalid_credentials', 401);
    }
    $user = query('SELECT * FROM users WHERE username=?', [$username])->fetch();
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
        $accent = is_string($body['accent']) ? ($namedAccents[$body['accent']] ?? $body['accent']) : null;
        if (!is_string($accent) || !preg_match('/^#[a-fA-F0-9]{6}$/', $accent)) {
            throw new ApiError('invalid_accent');
        }
        $updates[] = 'accent=?';
        $values[] = strtolower($accent);
    }
    if (array_key_exists('avatar_file_id', $body)) {
        $avatarId = $body['avatar_file_id'] === null ? null : intValue($body['avatar_file_id']);
        if ($avatarId !== null) {
            $file = query('SELECT * FROM files WHERE id=? AND owner_id=?', [$avatarId, $user['id']])->fetch();
            if (!$file || !in_array($file['mime'], ['image/jpeg', 'image/png', 'image/webp'], true)) {
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
            $key = 'direct:' . min($userId, $other) . ':' . max($userId, $other);
            $id = transaction(function () use ($key, $userId, $other): int {
                lockKey($key);
                query("INSERT INTO conversations(type,owner_id,direct_key,created_at,updated_at) VALUES('direct',?,?,?,?) ON CONFLICT(direct_key) DO NOTHING", [$userId, $key, time(), time()]);
                $id = (int)query('SELECT id FROM conversations WHERE direct_key=?', [$key])->fetchColumn();
                foreach ([$userId, $other] as $member) {
                    query('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING', [$id, $member]);
                }
                return $id;
            });
        }
    } else {
        $name = textValue($body['name'] ?? '', 80, 1);
        $description=textValue($body['description']??'',500);
        $slug=$type==='channel'?channelSlug($body['slug']??null):null;
        $visibility=$type==='channel'?($body['visibility']??'private'):'private';
        if(!in_array($visibility,['public','private'],true)||$visibility==='public'&&!$slug)throw new ApiError('invalid_channel_slug');
        $members = $body['user_ids'] ?? [];
        if (!is_array($members) || !array_is_list($members) || count($members) > 49) {
            throw new ApiError('invalid_members');
        }
        $members = array_unique(array_merge([$userId], array_map(fn(mixed $id) => intValue($id), $members)));
        foreach ($members as $member) {
            if (!query('SELECT id FROM users WHERE id=?', [$member])->fetchColumn()) {
                throw new ApiError('invalid_members');
            }
        }
        $id = transaction(function () use ($type, $name, $userId, $members,$description,$slug,$visibility): int {
            try{$id = insertId('INSERT INTO conversations(type,name,owner_id,created_at,updated_at,description,slug,visibility,invite_token) VALUES(?,?,?,?,?,?,?,?,?)', [$type, $name, $userId, time(), time(),$description,$slug,$visibility,$type==='channel'?bin2hex(random_bytes(24)):null]);}catch(PDOException $error){if($error->getCode()==='23505')throw new ApiError('channel_slug_taken',409);throw $error;}
            foreach ($members as $member) {
                query('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?)', [$id, $member]);
            }
            return $id;
        });
    }
    return normalizedConversation(conversationFor($id, $userId), $userId);
}

function messagesList(array $input, int $userId): array
{
    $conversationId = intValue($input['conversation_id'] ?? null);
    conversationFor($conversationId, $userId);
    $limit = isset($input['limit']) ? min(100, intValue($input['limit'])) : 50;
    $after = isset($input['after_id']) ? intValue($input['after_id'], 0) : 0;
    $before = isset($input['before_id']) ? intValue($input['before_id']) : null;
    $cursor=(int)query('SELECT COALESCE(MAX(change_seq),0) FROM messages WHERE conversation_id=?',[$conversationId])->fetchColumn();
    $params = [$conversationId,$userId];
    $where = 'conversation_id=? AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=messages.id AND h.user_id=?)';
    if ($after > 0) {
        $where .= ' AND id>?';
        $params[] = $after;
    }
    if ($before !== null) {
        $where .= ' AND id<?';
        $params[] = $before;
    }
    $direction = $after > 0 ? 'ASC' : 'DESC';
    $rows = query('SELECT * FROM messages WHERE ' . $where . ' ORDER BY id ' . $direction . ' LIMIT ' . ($limit + 1), $params)->fetchAll();
    $hasMore = count($rows) > $limit;
    if ($hasMore) {
        array_pop($rows);
    }
    if ($direction === 'DESC') {
        $rows = array_reverse($rows);
    }
    $pins = query('SELECT * FROM messages WHERE conversation_id=? AND pinned=1 AND deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=messages.id AND h.user_id=?) ORDER BY id DESC LIMIT 20', [$conversationId,$userId])->fetchAll();
    return [
        'change_cursor'=>$cursor,
        'messages' => normalizedMessages($rows,$userId),
        'has_more' => $hasMore,
        'pinned_messages' => normalizedMessages($pins,$userId),
    ];
}

function syncData(array $input, array $user): array
{
    $userId = (int)$user['id'];
    $events = notificationsList($input,$user);
    $data = ['events'=>$events['events'],'event_cursor'=>$events['event_cursor'],'notification_settings'=>$events['settings'],'conversations' => conversationsList($userId), 'messages' => [], 'updated_messages' => [], 'typing' => [], 'user' => normalizedUser($user, true), 'server_time' => time()];
    if (!empty($input['conversation_id'])) {
        $id = intValue($input['conversation_id']);
        conversationFor($id, $userId);
        $after = intValue($input['after_id'] ?? 0, 0);
        $new = query('SELECT * FROM messages WHERE conversation_id=? AND id>? ORDER BY id ASC LIMIT 100', [$id, $after])->fetchAll();
        $change=intValue($input['after_change_seq']??0,0);
        $updates=query('SELECT * FROM messages WHERE conversation_id=? AND change_seq>? ORDER BY change_seq LIMIT 200',[$id,$change])->fetchAll();
        $data['messages']=normalizedMessages($new,$userId);
        $data['updated_messages']=normalizedMessages($updates,$userId);
        $data['change_cursor']=$updates?(int)max(array_column($updates,'change_seq')):$change;
        $typing = query('SELECT u.id,u.name FROM typing t JOIN users u ON u.id=t.user_id WHERE t.conversation_id=? AND t.user_id<>? AND t.expires_at>?', [$id, $userId, time()])->fetchAll();
        $data['typing'] = array_map(fn(array $row) => ['id' => (int)$row['id'], 'name' => $row['name']], $typing);
    }
    return $data;
}

function uploadFile(array $user): array
{
    rateLimit('upload', 20, 60, (string)$user['id']);
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > (int)(config()['max_upload_bytes'] ?? 10485760) + 131072) {
        throw new ApiError('file_too_large', 413);
    }
    $file = $_FILES['file'] ?? null;
    if (!is_array($file) || !isset($file['error']) || is_array($file['error'])) {
        throw new ApiError('upload_failed');
    }
    if (in_array($file['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
        throw new ApiError('file_too_large', 413);
    }
    if ($file['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
        throw new ApiError('upload_failed');
    }
    $size = filesize($file['tmp_name']);
    if (!$size || $size > (int)(config()['max_upload_bytes'] ?? 10485760)) {
        throw new ApiError('file_too_large', 413);
    }
    $name = preg_replace('/[\x00-\x1F\x7F\/\\\\]/u', '_', (string)$file['name']);
    $name = textValue($name ?? '', 180, 1);
    $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
    $purpose = $_POST['purpose'] ?? 'file';
    if (!in_array($purpose, ['file', 'avatar', 'voice'], true)) {
        throw new ApiError('file_type_forbidden', 415);
    }
    $allowed = [
        'jpg' => ['image/jpeg'], 'jpeg' => ['image/jpeg'], 'png' => ['image/png'], 'webp' => ['image/webp'],
        'pdf' => ['application/pdf'], 'txt' => ['text/plain'], 'zip' => ['application/zip', 'application/x-zip-compressed'],
        'webm' => ['audio/webm', 'video/webm'], 'ogg' => ['audio/ogg', 'application/ogg'],
        'wav' => ['audio/wav', 'audio/x-wav'], 'm4a' => ['audio/mp4', 'video/mp4'], 'mp3' => ['audio/mpeg'],
    ];
    if (!isset($allowed[$extension]) || !in_array($mime, $allowed[$extension], true)) {
        throw new ApiError('file_type_forbidden', 415);
    }
    $isImage = in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true);
    if ($purpose === 'avatar' && !$isImage) {
        throw new ApiError('invalid_avatar');
    }
    if ($isImage) {
        $image = @getimagesize($file['tmp_name']);
        if (!$image || $image[0] > 8192 || $image[1] > 8192 || $image[0] * $image[1] > 20000000) {
            throw new ApiError('file_type_forbidden', 415);
        }
    }
    if (in_array($extension, ['webm', 'ogg', 'wav', 'm4a', 'mp3'], true)) {
        $mime = match ($extension) { 'webm' => 'audio/webm', 'ogg' => 'audio/ogg', 'm4a' => 'audio/mp4', 'wav' => 'audio/wav', default => 'audio/mpeg' };
    } elseif ($purpose === 'voice') {
        throw new ApiError('file_type_forbidden', 415);
    }
    $diskName = bin2hex(random_bytes(24)) . '.bin';
    $path = config()['upload_dir'] . '/' . $diskName;
    if (!move_uploaded_file($file['tmp_name'], $path)) {
        throw new ApiError('upload_failed', 500);
    }
    @chmod($path, 0600);
    try {
        $id = insertId('INSERT INTO files(owner_id,disk_name,original_name,mime,size,created_at) VALUES(?,?,?,?,?,?)', [$user['id'], $diskName, $name, $mime, $size, time()]);
    } catch (Throwable $error) {
        @unlink($path);
        throw $error;
    }
    return fileObject(query('SELECT * FROM files WHERE id=?', [$id])->fetch());
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
            $_SESSION['session_version'] = (int)query('SELECT session_version FROM users WHERE id=?', [$userId])->fetchColumn();
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
            session_regenerate_id(true);
            return ['user' => normalizedUser(currentUser(), true), 'csrf' => $_SESSION['csrf']];
        case 'profile.update':
            rateLimit('profile', 30, 60, (string)$userId);
            return profileUpdate($input, $user);
        case 'users.search':
            rateLimit('user_search', 90, 60, (string)$userId);
            $search = textValue($input['q'] ?? '', 80);
            $search = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $search) . '%';
            return array_map(fn(array $row) => normalizedUser($row), query("SELECT * FROM users WHERE id<>? AND (username ILIKE ? ESCAPE '\\' OR name ILIKE ? ESCAPE '\\') ORDER BY name LIMIT 50", [$userId, $search, $search])->fetchAll());
        case 'users.profile':
            $profile = query('SELECT * FROM users WHERE id=?', [intValue($input['user_id'] ?? null)])->fetch();
            if (!$profile) {
                throw new ApiError('user_not_found', 404);
            }
            return normalizedUser($profile, (int)$profile['id'] === $userId);
        case 'conversations.list':
            return conversationsList($userId);
        case 'channels.search':
        case 'channels.join':
        case 'channels.leave':
        case 'channels.update':
            return channelsHandle($action,$input,$user);
        case 'conversations.create':
            return conversationsCreate($input, $user);
        case 'conversations.read':
            $id = intValue($input['conversation_id'] ?? null);
            conversationFor($id, $userId);
            $messageId = intValue($input['last_message_id'] ?? 0, 0);
            if ($messageId) {
                $message = messageFor($messageId, $userId, true);
                if ((int)$message['conversation_id'] !== $id) {
                    throw new ApiError('message_not_found', 404);
                }
            }
            query('UPDATE conversation_members SET last_read_message_id=GREATEST(last_read_message_id,?) WHERE conversation_id=? AND user_id=?', [$messageId, $id, $userId]);
            return normalizedConversation(conversationFor($id, $userId), $userId);
        case 'conversations.pin':
            $id = intValue($input['conversation_id'] ?? null);
            conversationFor($id, $userId);
            query('UPDATE conversation_members SET pinned=? WHERE conversation_id=? AND user_id=?', [!empty($input['pinned']) ? 1 : 0, $id, $userId]);
            return normalizedConversation(conversationFor($id, $userId), $userId);
        case 'messages.list':
            return messagesList($input, $userId);
        case 'messages.send':
            return sendMessage($input, $user);
        case 'messages.edit':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            if ((int)$message['sender_id'] !== $userId) {
                throw new ApiError('edit_forbidden', 403);
            }
            if($message['kind']==='call')throw new ApiError('system_message_action');
            $text = textValue($input['text'] ?? '', 10000, $message['file_id'] ? 0 : 1);
            query('UPDATE messages SET text=?,edited=1,updated_at=? WHERE id=?', [$text, time(), $message['id']]);
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'messages.delete':
            $message=messageFor(intValue($input['message_id']??null),$userId,true);
            $conversation=conversationFor((int)$message['conversation_id'],$userId);
            $scope=$input['scope']??'everyone';
            if(!in_array($scope,['self','everyone'],true))throw new ApiError('invalid_delete_scope');
            if($scope==='self'){
                transaction(function()use($message,$userId):void{
                    lockKey('chat:'.$message['conversation_id']);
                    query('INSERT INTO message_hidden(user_id,message_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',[$userId,$message['id'],time()]);
                    // Advance the change cursor for the account's other devices, without deleting content.
                    query('UPDATE messages SET change_seq=change_seq WHERE id=? OR reply_to=?',[$message['id'],$message['id']]);
                });
            }else{
                $owner=in_array($conversation['type'],['group','channel'],true)&&(int)$conversation['owner_id']===$userId;
                $direct=in_array($conversation['type'],['direct','saved'],true);
                if((int)$message['sender_id']!==$userId&&!$owner&&!$direct&&$user['role']!=='admin')throw new ApiError('delete_forbidden',403);
                transaction(function()use($message):void{
                    lockKey('chat:'.$message['conversation_id']);
                    query('UPDATE messages SET deleted=1,text=?,file_id=NULL,pinned=0,updated_at=? WHERE id=?',['',time(),$message['id']]);
                    query('DELETE FROM reactions WHERE message_id=?',[$message['id']]);
                    query('UPDATE messages SET change_seq=change_seq WHERE reply_to=?',[$message['id']]);
                });
            }
            return normalizedMessage(messageFor((int)$message['id'],$userId,true),$userId);
        case 'messages.react':
            rateLimit('reaction', 90, 60, (string)$userId);
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $emoji = $input['emoji'] ?? '';
            if (!in_array($emoji, ['❤️', '👍', '🔥', '😂', '🎉', '😮', '👀', '💜', '👏', '😢', '🥹', '✨', '🙌'], true)) {
                throw new ApiError('invalid_emoji');
            }
            transaction(function () use ($message, $userId, $emoji): void {
                query('SELECT id FROM messages WHERE id=? FOR UPDATE',[$message['id']]);
                $exists = query('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [$message['id'], $userId, $emoji])->fetchColumn();
                if ($exists) {
                    query('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [$message['id'], $userId, $emoji]);
                } else {
                    query('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)', [$message['id'], $userId, $emoji]);
                }
                query('UPDATE messages SET updated_at=? WHERE id=?', [time(), $message['id']]);
            });
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'messages.pin':
            $message = messageFor(intValue($input['message_id'] ?? null), $userId);
            $conversation = conversationFor((int)$message['conversation_id'], $userId);
            if (in_array($conversation['type'], ['group', 'channel'], true) && (int)$conversation['owner_id'] !== $userId && $user['role'] !== 'admin') {
                throw new ApiError('pin_forbidden', 403);
            }
            query('UPDATE messages SET pinned=?,updated_at=? WHERE id=?', [!empty($input['pinned']) ? 1 : 0, time(), $message['id']]);
            return normalizedMessage(messageFor((int)$message['id'], $userId), $userId);
        case 'messages.forward':
            $source = messageFor(intValue($input['message_id'] ?? null), $userId);
            return sendMessage($input, $user, $source);
        case 'messages.save':
            $source = messageFor(intValue($input['message_id'] ?? null), $userId);
            return sendMessage(['conversation_id' => savedConversation($userId), 'client_id' => 'save:message:' . $source['id'], 'text' => ''], $user, $source);
        case 'messages.search':
            rateLimit('message_search', 90, 60, (string)$userId);
            $term = textValue($input['q'] ?? '', 100, 1);
            $term = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $term) . '%';
            $params = [$userId, $term];
            $scope = '';
            if (!empty($input['conversation_id'])) {
                $id = intValue($input['conversation_id']);
                conversationFor($id, $userId);
                $scope = ' AND m.conversation_id=?';
                $params[] = $id;
            }
            return normalizedMessages(query("SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE cm.user_id=? AND m.deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=cm.user_id) AND m.text ILIKE ? ESCAPE '\\'" . $scope . ' ORDER BY m.id DESC LIMIT 50', $params)->fetchAll(),$userId);
        case 'typing.set':
            rateLimit('typing', 60, 60, (string)$userId);
            $id = intValue($input['conversation_id'] ?? null);
            mayPost(conversationFor($id, $userId), $user);
            if (($input['typing'] ?? true) === false) {
                query('DELETE FROM typing WHERE conversation_id=? AND user_id=?', [$id, $userId]);
            } else {
                query('INSERT INTO typing(conversation_id,user_id,expires_at) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET expires_at=excluded.expires_at', [$id, $userId, time() + 7]);
            }
            return ['typing' => true];
        case 'sync':
            return syncData($input, $user);
        case 'files.upload':
            return uploadFile($user);
    }
    throw new ApiError('invalid_action', 404);
}
