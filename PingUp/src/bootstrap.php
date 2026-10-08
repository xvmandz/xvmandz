<?php
declare(strict_types=1);

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

function normalizedUser(array $user, bool $self = false): array
{
    $result = [
        'id' => (int)$user['id'], 'name' => $user['name'], 'username' => $user['username'],
        'bio' => $user['bio'], 'avatar_url' => $user['avatar_file_id'] ? 'media.php?id=' . (int)$user['avatar_file_id'] : null,
        'accent' => $user['accent'], 'location' => $user['location'], 'website' => $user['website'],
        'role' => $user['role'], 'is_verified' => $user['role'] === 'admin',
        'online' => (int)$user['last_seen'] >= time() - 90,
        'last_seen' => (int)$user['last_seen'], 'created_at' => (int)$user['created_at'],
    ];
    if ($self) {
        $result['locale'] = $user['locale'];
        $result['theme'] = $user['theme'];
    }
    return $result;
}

function conversationFor(int $id, int $userId): array
{
    $conversation = query('SELECT c.*,cm.last_read_message_id,cm.pinned AS member_pinned,cm.notification_mode FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.id=? AND cm.user_id=?', [$id, $userId])->fetch();
    if (!$conversation) {
        throw new ApiError('conversation_not_found', 404);
    }
    return $conversation;
}

function messageFor(int $id, int $userId, bool $allowDeleted = false): array
{
    $message = query('SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE m.id=? AND cm.user_id=?', [$id, $userId])->fetch();
    if (!$message || (!$allowDeleted && ((int)$message['deleted'] || hiddenMessage($id,$userId)))) {
        throw new ApiError('message_not_found', 404);
    }
    return $message;
}

function fileObject(array $file): array
{
    return ['id' => (int)$file['id'], 'name' => $file['original_name'], 'mime' => $file['mime'], 'size' => (int)$file['size'], 'url' => 'media.php?id=' . (int)$file['id']];
}

function placeholders(array $ids): string { return implode(',',array_fill(0,count($ids),'?')); }
function hiddenMessage(int $id,int $userId): bool {
    return (bool)query('SELECT 1 FROM message_hidden WHERE user_id=? AND message_id=?',[$userId,$id])->fetchColumn();
}
function normalizedMessages(array $rows,int $userId): array
{
    if(!$rows)return [];
    $ids=array_column($rows,'id');$fileIds=array_values(array_unique(array_filter(array_column($rows,'file_id'))));
    $replyIds=array_values(array_unique(array_filter(array_column($rows,'reply_to'))));
    $callIds=array_values(array_unique(array_filter(array_column($rows,'call_id'))));
    $context=['files'=>[],'replies'=>[],'reactions'=>[],'hidden'=>[],'calls'=>[]];
    if($fileIds)foreach(query('SELECT * FROM files WHERE id IN ('.placeholders($fileIds).')',$fileIds)->fetchAll() as $row)$context['files'][$row['id']]=$row;
    if($replyIds)foreach(query('SELECT * FROM messages WHERE id IN ('.placeholders($replyIds).')',$replyIds)->fetchAll() as $row)$context['replies'][$row['id']]=$row;
    foreach(query('SELECT message_id FROM message_hidden WHERE user_id=? AND message_id IN ('.placeholders(array_merge($ids,$replyIds)).')',array_merge([$userId],$ids,$replyIds))->fetchAll() as $row)$context['hidden'][$row['message_id']]=true;
    foreach(query('SELECT message_id,emoji,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE message_id IN ('.placeholders($ids).') GROUP BY message_id,emoji ORDER BY emoji',array_merge([$userId],$ids))->fetchAll() as $row){$row['count']=(int)$row['count'];$row['mine']=(bool)$row['mine'];$messageId=$row['message_id'];unset($row['message_id']);$context['reactions'][$messageId][]=$row;}
    if($callIds)foreach(query('SELECT id,caller_id,callee_id,kind,status,created_at,answered_at,ended_at,end_reason FROM calls WHERE id IN ('.placeholders($callIds).')',$callIds)->fetchAll() as $row)$context['calls'][$row['id']]=$row;
    return array_map(fn($row)=>normalizedMessage($row,$userId,$context),$rows);
}
function normalizedMessage(array $message,int $userId,?array $context=null): array
{
    if($context===null)return normalizedMessages([$message],$userId)[0];
    $hidden=isset($context['hidden'][$message['id']]);$deleted=(bool)$message['deleted'];
    $file=!$deleted&&!$hidden&&$message['file_id']?($context['files'][$message['file_id']]??null):null;
    $reply=!$deleted&&!$hidden&&$message['reply_to']?($context['replies'][$message['reply_to']]??null):null;
    if($reply){$unavailable=$reply['deleted']||isset($context['hidden'][$reply['id']]);$reply=['id'=>(int)$reply['id'],'sender_id'=>(int)$reply['sender_id'],'text'=>$unavailable?'':$reply['text'],'kind'=>$reply['kind'],'deleted'=>(bool)$unavailable];}
    $call=!$deleted&&!$hidden&&$message['call_id']?($context['calls'][$message['call_id']]??null):null;
    if($call)$call=['id'=>(int)$call['id'],'kind'=>$call['kind'],'status'=>$call['status'],'incoming'=>(int)$call['callee_id']===$userId,'peer_id'=>(int)($call['caller_id']===$userId?$call['callee_id']:$call['caller_id']),'duration'=>$call['answered_at']&&$call['ended_at']?max(0,(int)$call['ended_at']-(int)$call['answered_at']):0,'reason'=>$call['end_reason']];
    return [
        'id'=>(int)$message['id'],'conversation_id'=>(int)$message['conversation_id'],'sender_id'=>(int)$message['sender_id'],
        'text'=>$deleted||$hidden?'':$message['text'],'kind'=>$message['kind'],'file'=>$file?fileObject($file):null,'call'=>$call,
        'reply_to'=>$message['reply_to']?(int)$message['reply_to']:null,'reply'=>$reply,'reactions'=>$deleted||$hidden?[]:($context['reactions'][$message['id']]??[]),
        'pinned'=>!$deleted&&!$hidden&&(bool)$message['pinned'],'edited'=>(bool)$message['edited'],'deleted'=>$deleted,'hidden'=>$hidden,
        'created_at'=>(int)$message['created_at'],'updated_at'=>(int)$message['updated_at'],'change_seq'=>(int)$message['change_seq'],
        'client_id'=>$message['client_id'],'forwarded'=>(bool)$message['forwarded_from'],
    ];
}
function normalizedConversation(array $conversation,int $userId,?array $context=null): array
{
    if($context===null)return normalizeConversations([$conversation],$userId)[0];
    $participants=$context['participants'][$conversation['id']]??[];$name=$conversation['name'];$avatar=$conversation['avatar_file_id']?'media.php?id='.$conversation['avatar_file_id']:null;
    if($conversation['type']==='direct')foreach($participants as $participant)if($participant['id']!==$userId){$name=$participant['name'];$avatar=$participant['avatar_url'];break;}
    return [
        'id'=>(int)$conversation['id'],'type'=>$conversation['type'],'name'=>$name,'avatar_url'=>$avatar,
        'unread'=>(int)($context['unread'][$conversation['id']]??0),'pinned'=>(bool)$conversation['member_pinned'],'owner_id'=>(int)$conversation['owner_id'],
        'participants'=>$participants,'member_count'=>(int)($context['counts'][$conversation['id']]??count($participants)),
        'invite_token'=>(int)$conversation['owner_id']===$userId?$conversation['invite_token']:null,
        'description'=>$conversation['description'],'slug'=>$conversation['slug'],'visibility'=>$conversation['visibility'],
        'notification_mode'=>$conversation['notification_mode'],'last_message'=>$context['last'][$conversation['id']]??null,
        'last_read_message_id'=>(int)$conversation['last_read_message_id'],'updated_at'=>(int)$conversation['updated_at'],
    ];
}
function normalizeConversations(array $rows,int $userId): array
{
    if(!$rows)return [];$ids=array_column($rows,'id');$in=placeholders($ids);
    $context=['participants'=>[],'last'=>[],'unread'=>[],'counts'=>[]];
    // One bounded participant query, one tail query, one unread query: no per-chat N+1.
    foreach(query('SELECT * FROM (SELECT u.*,cm.conversation_id,COUNT(*) OVER(PARTITION BY cm.conversation_id) AS member_count,ROW_NUMBER() OVER(PARTITION BY cm.conversation_id ORDER BY u.name,u.id) AS position FROM users u JOIN conversation_members cm ON cm.user_id=u.id WHERE cm.conversation_id IN ('.$in.')) p WHERE position<=100',$ids)->fetchAll() as $row){$context['participants'][$row['conversation_id']][]=normalizedUser($row);$context['counts'][$row['conversation_id']]=(int)$row['member_count'];}
    $last=query('SELECT DISTINCT ON(m.conversation_id) m.* FROM messages m WHERE m.conversation_id IN ('.$in.') AND m.deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?) ORDER BY m.conversation_id,m.id DESC',array_merge($ids,[$userId]))->fetchAll();
    foreach(normalizedMessages($last,$userId) as $row)$context['last'][$row['conversation_id']]=$row;
    foreach(query('SELECT m.conversation_id,COUNT(*) AS unread FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? WHERE m.conversation_id IN ('.$in.') AND m.id>cm.last_read_message_id AND m.sender_id<>? AND m.deleted=0 AND NOT EXISTS(SELECT 1 FROM message_hidden h WHERE h.message_id=m.id AND h.user_id=?) GROUP BY m.conversation_id',array_merge([$userId],$ids,[$userId,$userId]))->fetchAll() as $row)$context['unread'][$row['conversation_id']]=$row['unread'];
    return array_map(fn($row)=>normalizedConversation($row,$userId,$context),$rows);
}
function conversationsList(int $userId): array
{
    return normalizeConversations(query('SELECT c.*,cm.last_read_message_id,cm.pinned AS member_pinned,cm.notification_mode FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=? ORDER BY cm.pinned DESC,c.updated_at DESC,c.id DESC LIMIT 200',[$userId])->fetchAll(),$userId);
}
function directConversation(int $a,int $b): int {
    $key='direct:'.min($a,$b).':'.max($a,$b);
    return transaction(function()use($a,$b,$key):int{
        lockKey($key);
        query("INSERT INTO conversations(type,owner_id,direct_key,created_at,updated_at) VALUES('direct',?,?,?,?) ON CONFLICT(direct_key) DO NOTHING",[$a,$key,time(),time()]);
        $id=(int)query('SELECT id FROM conversations WHERE direct_key=?',[$key])->fetchColumn();
        foreach([$a,$b] as $user)query('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING',[$id,$user]);
        return $id;
    });
}

function savedConversation(int $userId): int
{
    $key = 'saved:' . $userId;
    query("INSERT INTO conversations(type,name,owner_id,direct_key,created_at,updated_at) VALUES('saved','',?,?,?,?) ON CONFLICT(direct_key) DO NOTHING", [$userId, $key, time(), time()]);
    $id = (int)query('SELECT id FROM conversations WHERE direct_key=?', [$key])->fetchColumn();
    query('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING', [$id, $userId]);
    return $id;
}

function mayPost(array $conversation, array $user): void
{
    if ($conversation['type'] === 'channel' && (int)$conversation['owner_id'] !== (int)$user['id'] && $user['role'] !== 'admin') {
        throw new ApiError('posting_forbidden', 403);
    }
}

function sendMessage(array $body, array $user, ?array $source = null): array
{
    $userId = (int)$user['id'];
    $conversationId = intValue($body['conversation_id'] ?? null);
    $conversation = conversationFor($conversationId, $userId);
    mayPost($conversation, $user);
    $clientId = textValue($body['client_id'] ?? '', 100, 8);
    if (!preg_match('/^[A-Za-z0-9_.:-]+$/', $clientId)) {
        throw new ApiError('invalid_client_id');
    }
    $existing = query('SELECT * FROM messages WHERE sender_id=? AND client_id=?', [$userId, $clientId])->fetch();
    if ($existing) {
        if ((int)$existing['conversation_id'] !== $conversationId) {
            throw new ApiError('client_id_conflict', 409);
        }
        return normalizedMessage($existing, $userId);
    }
    rateLimit('send', 90, 60, (string)$userId);
    if($source && $source['kind']==='call')throw new ApiError('system_message_action',400);
    $text = $source ? $source['text'] : textValue($body['text'] ?? '', 10000);
    $fileId = $source ? $source['file_id'] : (!empty($body['file_id']) ? intValue($body['file_id']) : null);
    $file = $fileId ? query('SELECT * FROM files WHERE id=?', [$fileId])->fetch() : false;
    if ($fileId && (!$file || (!$source && (int)$file['owner_id'] !== $userId))) {
        throw new ApiError('file_not_found', 404);
    }
    if ($text === '' && !$fileId) {
        throw new ApiError('message_empty');
    }
    $replyId = !empty($body['reply_to']) ? intValue($body['reply_to']) : null;
    if ($replyId) {
        $reply = messageFor($replyId, $userId);
        if ((int)$reply['conversation_id'] !== $conversationId) {
            throw new ApiError('invalid_reply');
        }
    }
    $kind = $file ? (str_starts_with($file['mime'], 'audio/') ? 'voice' : 'file') : 'text';
    return transaction(function () use ($conversationId, $userId, $text, $kind, $fileId, $replyId, $source, $clientId): array {
        lockKey('send:'.$userId.':'.$clientId);
        $existing = query('SELECT * FROM messages WHERE sender_id=? AND client_id=?', [$userId, $clientId])->fetch();
        if ($existing) {
            if ((int)$existing['conversation_id'] !== $conversationId) {
                throw new ApiError('client_id_conflict', 409);
            }
            return normalizedMessage($existing, $userId);
        }
        lockKey('chat:'.$conversationId);
        $now = time();
        $id = insertId('INSERT INTO messages(conversation_id,sender_id,text,kind,file_id,reply_to,forwarded_from,client_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [$conversationId, $userId, $text, $kind, $fileId, $replyId, $source['id'] ?? null, $clientId, $now, $now]);
        query('UPDATE conversations SET updated_at=? WHERE id=?', [$now, $conversationId]);
        query('DELETE FROM typing WHERE conversation_id=? AND user_id=?', [$conversationId, $userId]);
        notificationMessage(messageFor($id, $userId));
        return normalizedMessage(messageFor($id, $userId), $userId);
    });
}

require_once __DIR__ . "/Notifications.php";
