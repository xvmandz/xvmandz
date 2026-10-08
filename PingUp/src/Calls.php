<?php
declare(strict_types=1);

function callInitialize(): void { /* Schema is installed explicitly by bin/migrate.php. */ }
function callRecord(array $call): void {
    transaction(function()use($call):void{
        lockKey('call-log:'.$call['id']);
        $latest=query('SELECT * FROM calls WHERE id=?',[$call['id']])->fetch();
        if(!$latest)return;
        $conv=directConversation((int)$latest['caller_id'],(int)$latest['callee_id']);
        lockKey('chat:'.$conv);
        query("INSERT INTO messages(conversation_id,sender_id,kind,client_id,created_at,updated_at,call_id) VALUES(?,?,'call',?,?,?,?) ON CONFLICT(call_id) DO UPDATE SET updated_at=excluded.updated_at",[$conv,$latest['caller_id'],'call:'.$latest['id'],$latest['created_at'],$latest['ended_at']??$latest['answered_at']??$latest['created_at'],$latest['id']]);
        query('UPDATE conversations SET updated_at=GREATEST(updated_at,?) WHERE id=?',[$latest['ended_at']??$latest['created_at'],$conv]);
    });
}
function callCleanup(): void {
    $now=time();
    $rows=query("UPDATE calls SET status='ended',ended_at=?,end_reason=CASE WHEN status='ringing' THEN 'timeout' ELSE 'disconnected' END WHERE (status='ringing' AND created_at<?) OR (status='active' AND (caller_heartbeat<? OR callee_heartbeat<?)) RETURNING *",[$now,$now-60,$now-180,$now-180])->fetchAll();
    foreach($rows as $call)callRecord($call);
    if(random_int(1,100)===1)query('DELETE FROM call_signals WHERE created_at<?',[$now-86400]);
}

function callFor(int $id, int $userId): array
{
    $call = query('SELECT * FROM calls WHERE id=? AND (caller_id=? OR callee_id=?)', [$id, $userId, $userId])->fetch();
    if (!$call) {
        throw new ApiError('call_not_found', 404);
    }
    return $call;
}

function callObject(array $call, int $userId): array
{
    $peerId = (int)$call['caller_id'] === $userId ? (int)$call['callee_id'] : (int)$call['caller_id'];
    $peer = query('SELECT * FROM users WHERE id=?', [$peerId])->fetch();
    return [
        'notification_event_id' => (int)$call['callee_id']===$userId ? (int)query('SELECT id FROM notification_events WHERE call_id=? AND user_id=?',[$call['id'],$userId])->fetchColumn() : null,
        'id' => (int)$call['id'], 'caller_id' => (int)$call['caller_id'], 'callee_id' => (int)$call['callee_id'],
        'kind' => $call['kind'], 'status' => $call['status'], 'incoming' => (int)$call['callee_id'] === $userId,
        'peer' => $peer ? normalizedUser($peer) : null, 'created_at' => (int)$call['created_at'],
        'answered_at' => $call['answered_at'] !== null ? (int)$call['answered_at'] : null,
        'ended_at' => $call['ended_at'] !== null ? (int)$call['ended_at'] : null, 'end_reason' => $call['end_reason'], 'owned' => ($call[(int)$call['caller_id']===$userId?'caller_device':'callee_device']??'') === (string)($_GET['device_id'] ?? ''),
    ];
}

function callSignalPayload(string $type, mixed $payload): string
{
    if (!is_array($payload) || array_is_list($payload)) {
        throw new ApiError('invalid_signal');
    }
    if ($type === 'offer' || $type === 'answer') {
        if (($payload['type'] ?? null) !== $type || !is_string($payload['sdp'] ?? null) || strlen($payload['sdp']) < 5 || strlen($payload['sdp']) > 65536 || !str_starts_with($payload['sdp'], 'v=0') || str_contains($payload['sdp'], "\0")) {
            throw new ApiError('invalid_signal');
        }
        $payload = ['type' => $type, 'sdp' => $payload['sdp']];
    } elseif ($type === 'candidate') {
        if (!is_string($payload['candidate'] ?? null) || strlen($payload['candidate']) > 4096 || !str_starts_with($payload['candidate'], 'candidate:') || str_contains($payload['candidate'], "\0")) {
            throw new ApiError('invalid_signal');
        }
        $mid = $payload['sdpMid'] ?? null;
        $line = $payload['sdpMLineIndex'] ?? null;
        $fragment = $payload['usernameFragment'] ?? null;
        if (($mid !== null && (!is_string($mid) || strlen($mid) > 100)) || ($line !== null && (!is_int($line) || $line < 0 || $line > 100)) || ($fragment !== null && (!is_string($fragment) || strlen($fragment) > 256))) {
            throw new ApiError('invalid_signal');
        }
        $payload = ['candidate' => $payload['candidate'], 'sdpMid' => $mid, 'sdpMLineIndex' => $line, 'usernameFragment' => $fragment];
    } else {
        throw new ApiError('invalid_signal');
    }
    try {
        return json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    } catch (JsonException) {
        throw new ApiError('invalid_signal');
    }
}

function callDevice(mixed $value): string {
    if($value===null)return ''; // old clients remain compatible during staged rollout
    if(!is_string($value)||!preg_match('/^[A-Za-z0-9_-]{8,100}$/D',$value))throw new ApiError('invalid_device');return $value;
}
function callOwnership(array $call,int $userId,string $device): void {
    $owner=$call[(int)$call['caller_id']===$userId?'caller_device':'callee_device']??'';
    if($owner!==''&&!hash_equals($owner,$device))throw new ApiError('call_taken',409);
}
function callsHandle(string $action, array $input, array $parameters, int $userId): array
{
    callInitialize();
    callCleanup();
    $device=callDevice($input['device_id']??$parameters['device_id']??null);
    if ($action === 'calls.start') {
        rateLimit('call_start', 10, 60, (string)$userId);
        $peerId = intValue($input['user_id'] ?? null);
        $kind = $input['kind'] ?? 'audio';
        if ($peerId === $userId || !in_array($kind, ['audio', 'video'], true)) {
            throw new ApiError('invalid_call');
        }
        if (!query('SELECT id FROM users WHERE id=?', [$peerId])->fetchColumn()) {
            throw new ApiError('user_not_found', 404);
        }
        // Blocks and the callee's "who can call me" setting are enforced server-side.
        if (blockedEither($userId, $peerId)) throw new ApiError('user_blocked', 403);
        if (!privacyAllows($peerId, $userId, 'calls')) throw new ApiError('privacy_restricted', 403);
        return transaction(function () use ($userId, $peerId, $kind, $device): array {
            foreach([min($userId,$peerId),max($userId,$peerId)] as $uid)lockKey('call-user:'.$uid);
            $busy = query("SELECT id FROM calls WHERE status IN ('ringing','active') AND (caller_id IN (?,?) OR callee_id IN (?,?)) LIMIT 1", [$userId, $peerId, $userId, $peerId])->fetchColumn();
            if ($busy) {
                throw new ApiError('call_busy', 409);
            }
            $now = time();
            $createdId = insertId('INSERT INTO calls(caller_id,callee_id,kind,created_at,caller_heartbeat,callee_heartbeat,caller_device) VALUES(?,?,?,?,?,?,?)', [$userId, $peerId, $kind, $now, $now, $now, $device]);
            callRecord(callFor($createdId,$userId));
            notificationEnqueue($peerId,'call',null,$createdId);
            return ['call' => callObject(callFor($createdId, $userId), $userId)];
        });
    }
    if ($action === 'calls.poll') {
        rateLimit('call_poll', 180, 60, (string)$userId);
        $afterId = intValue($parameters['after_id'] ?? 0, 0);
        // Only the browser actually handling this call supplies its heartbeat.
        // Another open tab must not keep a disconnected media session alive.
        $heartbeatId = intValue($parameters['call_id'] ?? 0, 0);
        if($heartbeatId>0){
            $heartbeatCall=callFor($heartbeatId,$userId);
            $owner=$heartbeatCall[(int)$heartbeatCall['caller_id']===$userId?'caller_device':'callee_device'];
            if(in_array($heartbeatCall['status'],['ringing','active'],true)&&($owner===''||hash_equals($owner,$device))){
                $field=(int)$heartbeatCall['caller_id']===$userId?'caller_heartbeat':'callee_heartbeat';
                query("UPDATE calls SET ".$field."=? WHERE id=? AND status IN ('ringing','active')",[time(),$heartbeatId]);
            }else $heartbeatId=0; // Other devices must still receive the terminal/taken status.
        }
        $calls = query("SELECT * FROM calls WHERE (caller_id=? OR callee_id=?) AND (status IN ('ringing','active') OR ended_at>=?) ORDER BY id DESC LIMIT 12", [$userId, $userId, time() - 120])->fetchAll();
        $rows = query("SELECT s.* FROM call_signals s JOIN calls c ON c.id=s.call_id WHERE (c.caller_id=? OR c.callee_id=?) AND s.sender_id<>? AND s.id>? AND c.id=? AND c.status IN ('ringing','active') ORDER BY s.id LIMIT 200", [$userId, $userId, $userId, $afterId, $heartbeatId])->fetchAll();
        $signals = array_map(static fn(array $row): array => ['id' => (int)$row['id'], 'call_id' => (int)$row['call_id'], 'type' => $row['type'], 'negotiation'=>(int)$row['negotiation'], 'payload' => json_decode($row['payload'], true)], $rows);
        return ['calls' => array_map(fn(array $row): array => callObject($row, $userId), $calls), 'signals' => $signals];
    }
    if ($action === 'calls.history') {
        rateLimit('call_history', 30, 60, (string)$userId);
        $rows = query('SELECT * FROM calls WHERE caller_id=? OR callee_id=? ORDER BY id DESC LIMIT 100', [$userId, $userId])->fetchAll();
        return ['entries' => array_map(fn(array $row): array => callObject($row, $userId), $rows)];
    }
    $callId = intValue($input['call_id'] ?? null);
    $call = callFor($callId, $userId);
    if ($action === 'calls.accept') {
        if ((int)$call['callee_id'] !== $userId) {
            throw new ApiError('call_forbidden', 403);
        }
        if ($call['status'] === 'active') {
            callOwnership($call,$userId,$device);
            return ['call' => callObject($call, $userId)];
        }
        if ($call['status'] !== 'ringing') {
            throw new ApiError('call_ended', 409);
        }
        transaction(function()use($callId,$userId,$device):void {
            $latest=query('SELECT * FROM calls WHERE id=? FOR UPDATE',[$callId])->fetch();
            if($latest['status']==='active'){callOwnership($latest,$userId,$device);return;}
            if($latest['status']!=='ringing')throw new ApiError('call_ended',409);
            query("UPDATE calls SET status='active',answered_at=?,callee_heartbeat=?,callee_device=? WHERE id=?",[time(),time(),$device,$callId]);
            callRecord(callFor($callId,$userId));
        });
        return ['call' => callObject(callFor($callId, $userId), $userId)];
    }
    if ($action === 'calls.end') {
        transaction(function()use($callId,$userId,$device):void{
            $call=query('SELECT * FROM calls WHERE id=? FOR UPDATE',[$callId])->fetch();
            if($call['status']==='active'||(int)$call['caller_id']===$userId)callOwnership($call,$userId,$device);
            if(in_array($call['status'],['ringing','active'],true)){
                $rejected=$call['status']==='ringing'&&(int)$call['callee_id']===$userId;
                $reason=$rejected?'rejected':($call['status']==='ringing'?'cancelled':'completed');
                query('UPDATE calls SET status=?,ended_at=?,end_reason=? WHERE id=?',[$rejected?'rejected':'ended',time(),$reason,$callId]);
                callRecord(callFor($callId,$userId));
            }
        });
        return ['call' => callObject(callFor($callId, $userId), $userId)];
    }
    if ($action === 'calls.signal') {
        callOwnership($call,$userId,$device);
        $negotiation=intValue($input['negotiation']??0,0);if($negotiation>5)throw new ApiError('signal_limit',429);
        rateLimit('call_signal', 240, 60, (string)$userId);
        if (!in_array($call['status'], ['ringing', 'active'], true)) {
            throw new ApiError('call_ended', 409);
        }
        $type = $input['type'] ?? '';
        if (!is_string($type) || !in_array($type, ['offer', 'answer', 'candidate'], true)) {
            throw new ApiError('invalid_signal');
        }
        if (($type === 'offer' && (int)$call['caller_id'] !== $userId) || ($type === 'answer' && ((int)$call['callee_id'] !== $userId || $call['status'] !== 'active'))) {
            throw new ApiError('call_forbidden', 403);
        }
        $payload = callSignalPayload($type, $input['payload'] ?? null);
        return transaction(function () use ($callId, $userId, $type, $payload, $negotiation): array {
            $current=query('SELECT * FROM calls WHERE id=? FOR UPDATE',[$callId])->fetch();
            if (!in_array($current['status'], ['ringing', 'active'], true)) {
                throw new ApiError('call_ended', 409);
            }
            if ($type !== 'candidate') {
                $existing = query('SELECT id,payload FROM call_signals WHERE call_id=? AND sender_id=? AND type=? AND negotiation=?', [$callId, $userId, $type, $negotiation])->fetch();
                if ($existing) {
                    if ($existing['payload'] !== $payload) {
                        throw new ApiError('signal_conflict', 409);
                    }
                    return ['signal_id' => (int)$existing['id']];
                }
            }
            if ((int)query('SELECT COUNT(*) FROM call_signals WHERE call_id=? AND sender_id=?', [$callId, $userId])->fetchColumn() >= 500) {
                throw new ApiError('signal_limit', 429);
            }
            $signalId=insertId('INSERT INTO call_signals(call_id,sender_id,type,payload,created_at,negotiation) VALUES(?,?,?,?,?,?)', [$callId, $userId, $type, $payload, time(), $negotiation]);
            return ['signal_id' => $signalId];
        });
    }
    throw new ApiError('unknown_action', 404);
}
