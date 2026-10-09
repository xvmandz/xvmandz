<?php
declare(strict_types=1);

const PINGUP_VERSION = '2.1.0';
const PINGUP_SCHEMA_VERSION = 5;

final class ApiError extends RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly int $status = 400, string $message = '')
    {
        parent::__construct($message ?: $errorCode);
    }
}

function config(): array
{
    static $config;
    if ($config === null) {
        $config = require dirname(__DIR__) . '/config.php';
        foreach (['storage_path','upload_dir','session_dir'] as $key) {
            if (empty($config[$key]) || !is_string($config[$key])) throw new RuntimeException('Missing private storage configuration.');
            $path=$config[$key];
            if (!is_dir($path) && !mkdir($path,0700,true) && !is_dir($path)) throw new RuntimeException('Private storage is not writable.');
            $resolved=realpath($path);$public=realpath(dirname(__DIR__).'/public');
            if($resolved && $public && ($resolved===$public || str_starts_with($resolved,$public.DIRECTORY_SEPARATOR))) throw new RuntimeException('Private storage must be outside public/.');
        }
        if(!str_starts_with($config['database_dsn']??'','pgsql:')) throw new RuntimeException('PostgreSQL DSN is required; SQLite is supported only by the import command.');
    }
    return $config;
}

function db(): PDO
{
    static $pdo;
    if($pdo===null){
        $cfg=config();
        $pdo=new PDO($cfg['database_dsn'],$cfg['database_user'],$cfg['database_password'],[
            PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC,PDO::ATTR_EMULATE_PREPARES=>false,
        ]);
        $pdo->exec("SET TIME ZONE 'UTC'; SET statement_timeout='10s'; SET lock_timeout='5s'; SET idle_in_transaction_session_timeout='15s'");
    }
    return $pdo;
}
function queryCount(bool $increment=false): int {static $count=0;return $increment?++$count:$count;}
function query(string $sql,array $params=[]): PDOStatement
{
    queryCount(true);
    $statement=db()->prepare($sql);
    $statement->execute($params);
    return $statement;
}
function insertId(string $sql,array $params=[]): int {
    return (int)query($sql.' RETURNING id',$params)->fetchColumn();
}
function lockKey(string $key): void {
    query('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',[$key]);
}
function transaction(callable $work): mixed
{
    if(db()->inTransaction())return $work();
    for($attempt=0;;$attempt++){
        db()->beginTransaction();
        try{$result=$work();db()->commit();return $result;}
        catch(Throwable $error){
            if(db()->inTransaction())db()->rollBack();
            if($error instanceof PDOException && in_array($error->getCode(),['40001','40P01'],true) && $attempt<2){usleep(random_int(10000,50000));continue;}
            throw $error;
        }
    }
}

function startSession(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    $config = config();
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.gc_maxlifetime', '86400');
    session_save_path($config['session_dir']);
    session_name($config['session_name'] ?? 'pingup_session');
    session_set_cookie_params([
        'lifetime' => 86400,
        'path' => '/',
        'secure' => (bool)($config['secure_cookies'] ?? (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    if (isset($_SESSION['user_id']) && time() - (int)($_SESSION['last_activity'] ?? time()) > 86400) {
        $_SESSION = ['csrf' => bin2hex(random_bytes(32))];
        session_regenerate_id(true);
    }
    $_SESSION['last_activity'] = time();
}

function currentUser(bool $required = true): ?array
{
    $id = (int)($_SESSION['user_id'] ?? 0);
    $user = $id ? query('SELECT * FROM users WHERE id = ?', [$id])->fetch() : false;
    if (!$user) {
        if ($required) {
            throw new ApiError('unauthorized', 401);
        }
        return null;
    }
    if ((int)($_SESSION['session_version'] ?? 1) !== (int)$user['session_version']) {
        unset($_SESSION['user_id'], $_SESSION['session_version']);
        if ($required) {
            throw new ApiError('unauthorized', 401);
        }
        return null;
    }
    if ((int)$user['last_seen'] < time() - 20) {
        $user['last_seen'] = time();
        query('UPDATE users SET last_seen = ? WHERE id = ?', [$user['last_seen'], $id]);
    }
    PrivacyCache::$viewer = (int)$user['id'];
    return $user;
}

function verifyCsrf(): void
{
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($token) || !hash_equals((string)($_SESSION['csrf'] ?? ''), $token)) {
        throw new ApiError('csrf_invalid', 403);
    }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $allowed = rtrim((string)(config()['app_origin'] ?? ''), '/');
    if ($origin !== '' && $allowed !== '' && !hash_equals($allowed, rtrim($origin, '/'))) {
        throw new ApiError('origin_invalid', 403);
    }
}

function rateLimit(string $scope, int $max, int $seconds, ?string $identity = null): void
{
    $identity ??= (string)($_SERVER['REMOTE_ADDR'] ?? 'cli');
    $bucket = hash('sha256', $scope . ':' . $identity . ':' . intdiv(time(), $seconds));
    $expires = (intdiv(time(), $seconds) + 1) * $seconds;
    $attempts=(int)query('INSERT INTO rate_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=rate_limits.attempts+1 RETURNING attempts',[$bucket,$expires])->fetchColumn();
    if ($attempts > $max) {
        header('Retry-After: ' . max(1, $expires - time()));
        throw new ApiError('rate_limited', 429);
    }
    if (random_int(1, 100) === 1) {
        query('DELETE FROM rate_limits WHERE expires_at < ?', [time()]);
        query('DELETE FROM typing WHERE expires_at < ?', [time()]);
    }
}

function jsonBody(): array
{
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 262144) {
        throw new ApiError('request_too_large', 413);
    }
    if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) {
        throw new ApiError('json_required', 415);
    }
    try {
        $value = json_decode(file_get_contents('php://input', false, null, 0, 262145), true, 32, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        throw new ApiError('invalid_json');
    }
    if (!is_array($value) || array_is_list($value) && $value !== []) {
        throw new ApiError('invalid_json');
    }
    return $value;
}

function intValue(mixed $value, int $min = 1): int
{
    if (filter_var($value, FILTER_VALIDATE_INT) === false || (int)$value < $min) {
        throw new ApiError('invalid_id');
    }
    return (int)$value;
}

function textValue(mixed $value, int $max, int $min = 0): string
{
    if (!is_string($value) || !preg_match('//u', $value)) {
        throw new ApiError('invalid_text');
    }
    $value = trim(str_replace("\0", '', $value));
    $length = function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : preg_match_all('/./us', $value);
    if ($length < $min || $length > $max) {
        throw new ApiError('invalid_length');
    }
    return $value;
}

function usernameValue(mixed $value): string
{
    $username = strtolower(textValue($value, 24, 3));
    if (!preg_match('/^[a-z][a-z0-9_]{2,23}$/', $username)) {
        throw new ApiError('invalid_username');
    }
    return $username;
}

function passwordValue(mixed $value): string
{
    // bcrypt-only hosts must reject input beyond its 72-byte boundary rather than truncate it.
    $maximum = defined('PASSWORD_ARGON2ID') ? 128 : 72;
    if (!is_string($value) || strlen($value) < 10 || strlen($value) > $maximum || str_contains($value, "\0")) {
        throw new ApiError('invalid_password');
    }
    return $value;
}

function passwordHash(string $password): string
{
    return password_hash($password, defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT);
}

function normalizedUser(array $user, bool $self = false, bool $adminView = false): array
{
    $id = (int)$user['id'];
    $viewer = viewerId();
    $full = $self || $adminView || $id === $viewer;
    $can = static fn(string $key): bool => $full || privacyAllows($id, $viewer, $key);
    $premium = premiumActive($id);
    $profile = $can('profile');
    $seen = $can('last_seen');
    $result = [
        'id' => $id, 'name' => $user['name'], 'username' => $user['username'],
        'bio' => $profile && $can('bio') ? $user['bio'] : '',
        'avatar_url' => $user['avatar_file_id'] && $can('avatar') ? 'media.php?id=' . (int)$user['avatar_file_id'] : null,
        'accent' => $user['accent'], 'location' => $profile ? $user['location'] : '', 'website' => $profile ? $user['website'] : '',
        'role' => $user['role'], 'is_verified' => $user['role'] === 'admin',
        'premium' => $premium, 'profile_effect' => $premium ? ($user['profile_effect'] ?? 'none') : 'none',
        'online' => $can('online') && (int)$user['last_seen'] >= time() - 90,
        'last_seen' => $seen ? (int)$user['last_seen'] : null, 'last_seen_hidden' => !$seen,
        'created_at' => $profile ? (int)$user['created_at'] : null,
    ];
    if ($self || $adminView) {
        $result['locale'] = $user['locale'];
        $result['theme'] = $user['theme'];
        $result['email'] = $user['email'] ?? null;
        $result['email_verified'] = !empty($user['email_verified_at']);
        $result['profile_effect_choice'] = $user['profile_effect'] ?? 'none';
    }
    return $result;
}

const MEMBER_COLUMNS = 'cm.last_read_message_id,cm.last_delivered_message_id,cm.pinned AS member_pinned,cm.notification_mode,cm.role AS member_role,cm.permissions AS member_permissions,cm.archived AS member_archived,cm.own_theme,cm.draft,cm.draft_updated_at';
const COMMUNITY_PERMISSIONS = ['post', 'edit_others', 'delete_others', 'pin', 'manage_members', 'ban', 'invite', 'change_info', 'view_stats', 'moderate_comments'];

function conversationFor(int $id, int $userId): array
{
    $conversation = query('SELECT c.*,' . MEMBER_COLUMNS . ' FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.id=? AND cm.user_id=?', [$id, $userId])->fetch();
    if (!$conversation) {
        throw new ApiError('conversation_not_found', 404);
    }
    conversationTypes([], [['conversation_id' => $id, 'conversation_type' => $conversation['type']]]);
    return $conversation;
}

/** Effective community permissions of the member row in $conversation. */
function memberPermissions(array $conversation, array $user): array
{
    $role = $conversation['member_role'] ?? 'member';
    $type = $conversation['type'];
    if (in_array($type, ['direct', 'saved'], true)) {
        return array_replace(array_fill_keys(COMMUNITY_PERMISSIONS, false), ['post' => true, 'pin' => true]);
    }
    if ($role === 'owner' || (int)$conversation['owner_id'] === (int)$user['id']) {
        $result = array_fill_keys(COMMUNITY_PERMISSIONS, true);
        if (!empty($conversation['archived_at'])) $result['post'] = false;
        return $result;
    }
    $custom = is_string($conversation['member_permissions'] ?? null) ? (json_decode($conversation['member_permissions'], true) ?: []) : [];
    $result = [];
    foreach (COMMUNITY_PERMISSIONS as $key) {
        $result[$key] = $role === 'admin' ? (bool)($custom[$key] ?? $key !== 'change_info') : false;
    }
    if ($type === 'group' && $role === 'member') {
        $settings = json_decode($conversation['settings'] ?? '{}', true) ?: [];
        $result['post'] = true;
        $result['invite'] = (bool)($settings['members_can_invite'] ?? true);
    }
    // Server administrators keep the moderation powers they had in 2.0.
    if ($user['role'] === 'admin') {
        foreach (['post', 'delete_others', 'pin', 'moderate_comments'] as $key) $result[$key] = true;
    }
    if (!empty($conversation['archived_at'])) {
        $result['post'] = false;
    }
    return $result;
}

function memberCan(array $conversation, array $user, string $permission): bool
{
    return memberPermissions($conversation, $user)[$permission] ?? false;
}

function messageFor(int $id, int $userId, bool $allowDeleted = false): array
{
    $message = query('SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE m.id=? AND cm.user_id=?', [$id, $userId])->fetch();
    if (!$message || (!$allowDeleted && ((int)$message['deleted'] || hiddenMessage($id,$userId)))) {
        throw new ApiError('message_not_found', 404);
    }
    return $message;
}

function fileKind(string $mime, string $name = ''): string
{
    if (str_starts_with($mime, 'image/')) return 'image';
    if (str_starts_with($mime, 'video/')) return 'video';
    if (str_starts_with($mime, 'audio/')) return 'audio';
    if ($mime === 'application/pdf') return 'pdf';
    if (in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), ['zip', 'rar', '7z', 'tar', 'gz'], true)) return 'archive';
    return 'document';
}

function fileObject(array $file): array
{
    return ['id' => (int)$file['id'], 'name' => $file['original_name'], 'mime' => $file['mime'], 'size' => (int)$file['size'], 'kind' => fileKind($file['mime'], $file['original_name']), 'url' => 'media.php?id=' . (int)$file['id']];
}

function placeholders(array $ids): string { return implode(',',array_fill(0,count($ids),'?')); }
function hiddenMessage(int $id,int $userId): bool {
    return (bool)query('SELECT 1 FROM message_hidden WHERE user_id=? AND message_id=?',[$userId,$id])->fetchColumn();
}

function normalizedMessages(array $rows,int $userId): array
{
    if(!$rows)return [];
    $ids=array_map('intval',array_column($rows,'id'));
    $collect=static fn(string $key):array=>array_values(array_unique(array_map('intval',array_filter(array_column($rows,$key)))));
    $fileIds=$collect('file_id');$replyIds=$collect('reply_to');$callIds=$collect('call_id');$pollIds=$collect('poll_id');$stickerIds=$collect('sticker_id');$forwardIds=$collect('forwarded_from');
    $albumIds=array_map('intval',array_column(array_filter($rows,fn($row)=>$row['kind']==='album'),'id'));
    $context=['files'=>[],'replies'=>[],'reactions'=>[],'hidden'=>[],'calls'=>[],'album'=>[],'polls'=>[],'stickers'=>[],'comments'=>[],'views'=>[],'stars'=>[],'forward'=>[]];
    if($albumIds)foreach(query('SELECT mf.message_id,f.* FROM message_files mf JOIN files f ON f.id=mf.file_id WHERE mf.message_id IN ('.placeholders($albumIds).') ORDER BY mf.message_id,mf.position',$albumIds)->fetchAll() as $row)$context['album'][$row['message_id']][]=fileObject($row);
    if($fileIds)foreach(query('SELECT * FROM files WHERE id IN ('.placeholders($fileIds).')',$fileIds)->fetchAll() as $row)$context['files'][$row['id']]=$row;
    $lookup=array_values(array_unique(array_merge($replyIds,$forwardIds)));
    if($lookup)foreach(query('SELECT m.*,c.type AS conversation_type,c.name AS conversation_name,c.visibility AS conversation_visibility,u.name AS sender_name FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=m.sender_id WHERE m.id IN ('.placeholders($lookup).')',$lookup)->fetchAll() as $row)$context['replies'][$row['id']]=$row;
    foreach(query('SELECT message_id FROM message_hidden WHERE user_id=? AND message_id IN ('.placeholders(array_merge($ids,$replyIds)).')',array_merge([$userId],$ids,$replyIds))->fetchAll() as $row)$context['hidden'][$row['message_id']]=true;
    foreach(query('SELECT message_id,emoji,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine,MIN(created_at) AS first_at FROM reactions WHERE message_id IN ('.placeholders($ids).') GROUP BY message_id,emoji ORDER BY MIN(created_at),emoji',array_merge([$userId],$ids))->fetchAll() as $row){$messageId=$row['message_id'];$context['reactions'][$messageId][]=['emoji'=>$row['emoji'],'count'=>(int)$row['count'],'mine'=>(bool)$row['mine']];}
    if($callIds)foreach(query('SELECT id,caller_id,callee_id,kind,status,created_at,answered_at,ended_at,end_reason FROM calls WHERE id IN ('.placeholders($callIds).')',$callIds)->fetchAll() as $row)$context['calls'][$row['id']]=$row;
    if($pollIds)$context['polls']=pollObjects($pollIds,$userId);
    if($stickerIds)foreach(query('SELECT id,pack_id,file_id,asset,emoji FROM stickers WHERE id IN ('.placeholders($stickerIds).')',$stickerIds)->fetchAll() as $row)$context['stickers'][$row['id']]=stickerObject($row);
    $roots=array_map('intval',array_column(array_filter($rows,fn($row)=>$row['thread_root_id']===null),'id'));
    $types=conversationTypes(array_column($rows,'conversation_id'),$rows);
    if($roots&&in_array('channel',$types,true)){
        foreach(query('SELECT thread_root_id,COUNT(*) AS count FROM messages WHERE thread_root_id IN ('.placeholders($roots).') AND deleted=0 GROUP BY thread_root_id',$roots)->fetchAll() as $row)$context['comments'][$row['thread_root_id']]=(int)$row['count'];
        foreach(query('SELECT message_id,views FROM message_views WHERE message_id IN ('.placeholders($roots).')',$roots)->fetchAll() as $row)$context['views'][$row['message_id']]=(int)$row['views'];
    }
    foreach(query('SELECT message_id FROM message_stars WHERE user_id=? AND message_id IN ('.placeholders($ids).')',array_merge([$userId],$ids))->fetchAll() as $row)$context['stars'][$row['message_id']]=true;
    return array_map(fn($row)=>normalizedMessage($row,$userId,$context),$rows);
}

/** Conversation types for message rows, cached per request (conversationFor() primes the cache). */
function conversationTypes(array $ids, array $rows = []): array
{
    static $cache = [];
    foreach ($rows as $row) if (isset($row['conversation_type'])) $cache[(int)$row['conversation_id']] = $row['conversation_type'];
    $ids = array_values(array_unique(array_map('intval', $ids)));
    $missing = array_values(array_filter($ids, fn(int $id) => !isset($cache[$id])));
    if ($missing) foreach (query('SELECT id,type FROM conversations WHERE id IN (' . placeholders($missing) . ')', $missing)->fetchAll() as $row) $cache[(int)$row['id']] = $row['type'];
    return array_intersect_key($cache, array_flip($ids));
}

function forwardSource(?array $source): ?array
{
    if(!$source)return null;
    if($source['conversation_type']==='channel')return ['type'=>'channel','name'=>$source['conversation_name'],'conversation_id'=>$source['conversation_visibility']==='public'?(int)$source['conversation_id']:null];
    return ['type'=>'user','name'=>$source['sender_name']];
}

function normalizedMessage(array $message,int $userId,?array $context=null): array
{
    if($context===null)return normalizedMessages([$message],$userId)[0];
    $hidden=isset($context['hidden'][$message['id']]);$deleted=(bool)$message['deleted'];$visible=!$deleted&&!$hidden;
    $file=$visible&&$message['file_id']?($context['files'][$message['file_id']]??null):null;
    $reply=$visible&&$message['reply_to']?($context['replies'][$message['reply_to']]??null):null;
    if($reply){$unavailable=$reply['deleted']||isset($context['hidden'][$reply['id']]);$reply=['id'=>(int)$reply['id'],'sender_id'=>(int)$reply['sender_id'],'sender_name'=>$reply['sender_name'],'text'=>$unavailable?'':$reply['text'],'kind'=>$reply['kind'],'deleted'=>(bool)$unavailable];}
    $call=$visible&&$message['call_id']?($context['calls'][$message['call_id']]??null):null;
    if($call)$call=['id'=>(int)$call['id'],'kind'=>$call['kind'],'status'=>$call['status'],'incoming'=>(int)$call['callee_id']===$userId,'peer_id'=>(int)($call['caller_id']===$userId?$call['callee_id']:$call['caller_id']),'duration'=>$call['answered_at']&&$call['ended_at']?max(0,(int)$call['ended_at']-(int)$call['answered_at']):0,'reason'=>$call['end_reason']];
    $id=(int)$message['id'];
    return [
        'id'=>$id,'conversation_id'=>(int)$message['conversation_id'],'sender_id'=>(int)$message['sender_id'],
        'text'=>$visible?$message['text']:'','kind'=>$message['kind'],'file'=>$file?fileObject($file):null,'call'=>$call,
        'files'=>$visible?($context['album'][$id]??[]):[],
        'poll'=>$visible&&$message['poll_id']?($context['polls'][$message['poll_id']]??null):null,
        'sticker'=>$visible&&$message['sticker_id']?($context['stickers'][$message['sticker_id']]??null):null,
        'reply_to'=>$message['reply_to']?(int)$message['reply_to']:null,'reply'=>$reply,'reactions'=>$visible?($context['reactions'][$id]??[]):[],
        'thread_root_id'=>$message['thread_root_id']!==null?(int)$message['thread_root_id']:null,
        'comment_count'=>$context['comments'][$id]??0,'views'=>$context['views'][$id]??0,'starred'=>isset($context['stars'][$id]),
        'pinned'=>$visible&&(bool)$message['pinned'],'edited'=>(bool)$message['edited'],'deleted'=>$deleted,'hidden'=>$hidden,
        'created_at'=>(int)$message['created_at'],'updated_at'=>(int)$message['updated_at'],'change_seq'=>(int)$message['change_seq'],
        'client_id'=>$message['client_id'],'forwarded'=>(bool)$message['forwarded_from'],
        'forward'=>$visible&&$message['forwarded_from']?forwardSource($context['replies'][$message['forwarded_from']]??null):null,
    ];
}

/** Public-safe community settings with defaults. */
function communitySettings(array $conversation): array
{
    $stored = json_decode($conversation['settings'] ?? '{}', true) ?: [];
    return array_replace(communityDefaults(), $stored);
}

function communityDefaults(): array
{
    return [
        'preset' => 'classic', 'accent' => null, 'header_color' => null, 'background' => null, 'gradient' => null,
        'card_style' => 'elevated', 'button_color' => null, 'welcome' => '', 'tagline' => '', 'links' => [],
        'category' => 'other', 'language' => 'other', 'show_subscriber_count' => true, 'show_author' => true,
        'reactions_enabled' => true, 'allowed_reactions' => [], 'comments_enabled' => false, 'members_can_invite' => true,
    ];
}

function normalizedConversation(array $conversation,int $userId,?array $context=null): array
{
    if($context===null)return normalizeConversations([$conversation],$userId)[0];
    $id=(int)$conversation['id'];
    $participants=$context['participants'][$id]??[];$name=$conversation['name'];$avatar=$conversation['avatar_file_id']?'media.php?id='.$conversation['avatar_file_id']:null;
    if($conversation['type']==='direct')foreach($participants as $participant)if($participant['id']!==$userId){$name=$participant['name'];$avatar=$participant['avatar_url'];break;}
    $user=$context['user'];
    $permissions=memberPermissions($conversation,$user);
    $settings=communitySettings($conversation);
    $isStaff=in_array($conversation['member_role'],['owner','admin'],true)||$user['role']==='admin';
    $count=(int)($context['counts'][$id]??count($participants));
    return [
        'id'=>$id,'type'=>$conversation['type'],'name'=>$name,'avatar_url'=>$avatar,
        'unread'=>(int)($context['unread'][$id]??0),'pinned'=>(bool)$conversation['member_pinned'],'owner_id'=>(int)$conversation['owner_id'],
        'participants'=>$participants,'member_count'=>$settings['show_subscriber_count']||$isStaff?$count:null,
        'invite_token'=>$permissions['invite']&&in_array($conversation['type'],['group','channel'],true)?$conversation['invite_token']:null,
        'description'=>$conversation['description'],'slug'=>$conversation['slug'],'visibility'=>$conversation['visibility'],
        'notification_mode'=>$conversation['notification_mode'],'last_message'=>$context['last'][$id]??null,
        'last_read_message_id'=>(int)$conversation['last_read_message_id'],'updated_at'=>(int)$conversation['updated_at'],
        'role'=>$conversation['member_role'],'permissions'=>$permissions,'settings'=>$settings,
        'cover_url'=>!empty($conversation['cover_file_id'])?'media.php?id='.$conversation['cover_file_id']:null,
        'discussion_id'=>$conversation['discussion_id']!==null?(int)$conversation['discussion_id']:null,
        'archived'=>(bool)$conversation['member_archived'],'own_theme'=>(bool)$conversation['own_theme'],
        'community_archived'=>$conversation['archived_at']!==null,
        'draft'=>$conversation['draft'],'draft_updated_at'=>(int)$conversation['draft_updated_at'],
        'peer_delivered'=>(int)($context['receipts'][$id]['delivered']??0),'peer_read'=>(int)($context['receipts'][$id]['read']??0),
        'last_delivered_message_id'=>(int)$conversation['last_delivered_message_id'],
    ];
}

function normalizeConversations(array $rows,int $userId): array
{
    if(!$rows)return [];$ids=array_map('intval',array_column($rows,'id'));$in=placeholders($ids);
    $user=query('SELECT * FROM users WHERE id=?',[$userId])->fetch();
    $context=['participants'=>[],'last'=>[],'unread'=>[],'counts'=>[],'receipts'=>[],'user'=>$user];
    // Channel subscribers are not disclosed to ordinary readers: they only see owners/admins.
    $restricted=array_map('intval',array_column(array_filter($rows,fn($row)=>$row['type']==='channel'&&!in_array($row['member_role'],['owner','admin'],true)&&$user['role']!=='admin'),'id'));
    $restriction=$restricted?' AND NOT (cm.conversation_id IN ('.placeholders($restricted).") AND cm.role='member' AND cm.user_id<>?)":'';
    $participantRows=query('SELECT * FROM (SELECT u.*,cm.conversation_id,cm.role AS member_role,ROW_NUMBER() OVER(PARTITION BY cm.conversation_id ORDER BY (cm.role=\'member\'),u.name,u.id) AS position FROM users u JOIN conversation_members cm ON cm.user_id=u.id WHERE cm.conversation_id IN ('.$in.')'.$restriction.') p WHERE position<=100',array_merge($ids,$restricted,$restricted?[$userId]:[]))->fetchAll();
    privacyPrefetch(array_column($participantRows,'id'),$userId);premiumPrefetch(array_column($participantRows,'id'));
    foreach($participantRows as $row)$context['participants'][$row['conversation_id']][]=normalizedUser($row)+['member_role'=>$row['member_role']];
    foreach(query('SELECT conversation_id,COUNT(*) AS count FROM conversation_members WHERE conversation_id IN ('.$in.') GROUP BY conversation_id',$ids)->fetchAll() as $row)$context['counts'][$row['conversation_id']]=(int)$row['count'];
    $last=query('SELECT DISTINCT ON(m.conversation_id) m.*,c.type AS conversation_type FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id IN ('.$in.') AND m.deleted=0 AND m.thread_root_id IS NULL AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?) ORDER BY m.conversation_id,m.id DESC',array_merge($ids,[$userId]))->fetchAll();
    foreach(normalizedMessages($last,$userId) as $row)$context['last'][$row['conversation_id']]=$row;
    foreach(query('SELECT m.conversation_id,COUNT(*) AS unread FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? WHERE m.conversation_id IN ('.$in.') AND m.id>cm.last_read_message_id AND m.sender_id<>? AND m.deleted=0 AND m.thread_root_id IS NULL AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?) GROUP BY m.conversation_id',array_merge([$userId],$ids,[$userId,$userId]))->fetchAll() as $row)$context['unread'][$row['conversation_id']]=$row['unread'];
    // Delivery/read cursors of other members. Read cursors respect each reader's read_receipts setting,
    // and a viewer who hides own receipts sees none (reciprocity).
    $receiptIds=array_map('intval',array_column(array_filter($rows,fn($row)=>in_array($row['type'],['direct','group'],true)),'id'));
    if($receiptIds){
        $ownHidden=(privacySettings($userId)['read_receipts']??'everyone')==='nobody';
        foreach(query("SELECT cm.conversation_id,MAX(cm.last_delivered_message_id) AS delivered,MAX(CASE WHEN COALESCE(ps.settings->>'read_receipts','everyone')='everyone' OR (ps.settings->>'read_receipts'='contacts' AND EXISTS(SELECT 1 FROM contacts k WHERE k.user_low=LEAST(cm.user_id,?) AND k.user_high=GREATEST(cm.user_id,?) AND k.status='accepted')) THEN cm.last_read_message_id ELSE 0 END) AS read FROM conversation_members cm LEFT JOIN privacy_settings ps ON ps.user_id=cm.user_id WHERE cm.conversation_id IN (".placeholders($receiptIds).") AND cm.user_id<>? AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.blocker_id=cm.user_id AND b.blocked_id=?) GROUP BY cm.conversation_id",array_merge([$userId,$userId],$receiptIds,[$userId,$userId]))->fetchAll() as $row){
            $context['receipts'][$row['conversation_id']]=['delivered'=>(int)$row['delivered'],'read'=>$ownHidden?0:(int)$row['read']];
        }
    }
    return array_map(fn($row)=>normalizedConversation($row,$userId,$context),$rows);
}

function conversationsList(int $userId): array
{
    return normalizeConversations(query('SELECT c.*,' . MEMBER_COLUMNS . ' FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=? ORDER BY cm.pinned DESC,c.updated_at DESC,c.id DESC LIMIT 300',[$userId])->fetchAll(),$userId);
}

/** The recipient's device received these messages: advance delivery cursors in one statement. */
function markDelivered(int $userId, array $conversations): void
{
    $pairs=[];
    foreach($conversations as $conversation){
        $last=(int)($conversation['last_message']['id']??0);
        if($last>(int)$conversation['last_delivered_message_id'])$pairs[]=[(int)$conversation['id'],$last];
    }
    if(!$pairs)return;
    $values=implode(',',array_fill(0,count($pairs),'(?::bigint,?::bigint)'));
    query('UPDATE conversation_members cm SET last_delivered_message_id=GREATEST(cm.last_delivered_message_id,v.last) FROM (VALUES '.$values.') AS v(conversation_id,last) WHERE cm.conversation_id=v.conversation_id AND cm.user_id=?',array_merge(array_merge(...$pairs),[$userId]));
}

function directConversation(int $a,int $b): int {
    $key='direct:'.min($a,$b).':'.max($a,$b);
    return transaction(function()use($a,$b,$key):int{
        lockKey($key);
        query("INSERT INTO conversations(type,owner_id,direct_key,created_at,updated_at) VALUES('direct',?,?,?,?) ON CONFLICT(direct_key) DO NOTHING",[$a,$key,time(),time()]);
        $id=(int)query('SELECT id FROM conversations WHERE direct_key=?',[$key])->fetchColumn();
        foreach([$a,$b] as $user)query('INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',[$id,$user,time()]);
        return $id;
    });
}

function savedConversation(int $userId): int
{
    $key = 'saved:' . $userId;
    query("INSERT INTO conversations(type,name,owner_id,direct_key,created_at,updated_at) VALUES('saved','',?,?,?,?) ON CONFLICT(direct_key) DO NOTHING", [$userId, $key, time(), time()]);
    $id = (int)query('SELECT id FROM conversations WHERE direct_key=?', [$key])->fetchColumn();
    query('INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [$id, $userId, time()]);
    return $id;
}

function directPeer(array $conversation, int $userId): ?int
{
    if ($conversation['type'] !== 'direct') return null;
    $peer = query('SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id<>? LIMIT 1', [$conversation['id'], $userId])->fetchColumn();
    return $peer === false ? null : (int)$peer;
}

function mayPost(array $conversation, array $user): void
{
    if (!memberCan($conversation, $user, 'post')) {
        throw new ApiError(!empty($conversation['archived_at']) ? 'community_archived' : 'posting_forbidden', 403);
    }
    $peer = directPeer($conversation, (int)$user['id']);
    if ($peer !== null && blockedEither((int)$user['id'], $peer)) {
        throw new ApiError('user_blocked', 403);
    }
}

require_once __DIR__ . '/Privacy.php';
require_once __DIR__ . '/Premium.php';
require_once __DIR__ . '/Messages.php';
require_once __DIR__ . '/Notifications.php';
