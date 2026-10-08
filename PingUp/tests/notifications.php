<?php
declare(strict_types=1);
// Requires a freshly migrated empty disposable PostgreSQL database named pingup_test_*.
$root=dirname(__DIR__);$storage=sys_get_temp_dir().'/pingup-notifications-pg-'.bin2hex(random_bytes(6));mkdir($storage,0700);
putenv('PINGUP_STORAGE_PATH='.$storage);putenv('PINGUP_APP_ORIGIN=https://app.example.test');
require $root.'/src/bootstrap.php';require $root.'/src/actions.php';require $root.'/src/Calls.php';require $root.'/src/PushWorker.php';require $root.'/vendor/autoload.php';
function check(bool $ok,string $label):void{if(!$ok)throw new RuntimeException('FAIL: '.$label);}
$name=(string)query('SELECT current_database()')->fetchColumn();
check(str_starts_with($name,'pingup_test_')&&(int)query('SELECT COUNT(*) FROM users')->fetchColumn()===0,'empty disposable database required');
check((int)query('SELECT MAX(version) FROM schema_migrations')->fetchColumn()===4,'PostgreSQL schema 4');
query("INSERT INTO users(username,name,password_hash,last_seen,created_at) VALUES('alice','Alice','test',1,1),('bob','Bob','test',1,1),('outsider','Outsider','test',1,1)");
$alice=query('SELECT * FROM users WHERE id=1')->fetch();$bob=query('SELECT * FROM users WHERE id=2')->fetch();$outsider=query('SELECT * FROM users WHERE id=3')->fetch();
$keys=Minishlink\WebPush\VAPID::createVapidKeys();file_put_contents(config()['vapid_file'],json_encode($keys));chmod(config()['vapid_file'],0600);
notificationUpdate(['system'=>true,'preview'=>true],2);
$sub=['endpoint'=>'https://fcm.googleapis.com/fcm/send/pingup-test-a','keys'=>['p256dh'=>$keys['publicKey'],'auth'=>rtrim(strtr(base64_encode(random_bytes(16)),'+/','-_'),'=')]];
pushSubscribe($sub,$bob);$sub['endpoint']='https://fcm.googleapis.com/fcm/send/pingup-test-b';pushSubscribe($sub,$bob);
try{$bad=$sub;$bad['endpoint']='https://127.0.0.1/ssrf';pushSubscribe($bad,$bob);throw new RuntimeException('SSRF accepted');}catch(ApiError $e){check($e->errorCode==='invalid_subscription'||$e->errorCode==='push_provider_unsupported','SSRF rejected');}
$direct=conversationsCreate(['type'=>'direct','user_id'=>2],$alice);
$body=['conversation_id'=>$direct['id'],'text'=>'Private test message','client_id'=>'notify-test-message-1'];$message=sendMessage($body,$alice);sendMessage($body,$alice);
check((int)query('SELECT COUNT(*) FROM notification_events')->fetchColumn()===1,'event dedup');check((int)query('SELECT COUNT(*) FROM push_deliveries')->fetchColumn()===2,'multi-device delivery');
$id=(int)query('SELECT id FROM notification_events')->fetchColumn();check(notificationResolve($id,$outsider)===null,'recipient authorization');check(notificationResolve($id,$bob)['body']==='Private test message','preview allowed');
notificationUpdate(['preview'=>false],2);check(!str_contains(notificationResolve($id,$bob)['body'],'Private'),'preview privacy');
query('UPDATE push_deliveries SET available_at=?',[time()-1]);$job=pushClaim();$other=pushClaim();check($job['id']!==$other['id'],'lease claim isolation');
$status=pushDeliver($job,function($subscription,$payload,$ttl){check(array_keys($payload)===['event_id','user_id'],'push contains no private text');return ['success'=>true];});check($status==='sent','success committed');
$status=pushDeliver($other,fn()=>['success'=>false,'expired'=>true]);check($status==='expired','expired endpoint removed');check((int)query('SELECT COUNT(*) FROM push_subscriptions')->fetchColumn()===1,'other device preserved');
notificationUpdate(['dnd'=>true],2);check(notificationResolve($id,$bob)===null,'DND');notificationUpdate(['dnd'=>false],2);
query('UPDATE conversation_members SET last_read_message_id=? WHERE conversation_id=? AND user_id=2',[$message['id'],$direct['id']]);check(notificationResolve($id,$bob)===null,'read suppression');
query("UPDATE conversation_members SET notification_mode='mentions' WHERE conversation_id=? AND user_id=2",[$direct['id']]);sendMessage(['conversation_id'=>$direct['id'],'text'=>'No mention','client_id'=>'notify-no-mention'],$alice);sendMessage(['conversation_id'=>$direct['id'],'text'=>'Hello @bob!','client_id'=>'notify-mention-1'],$alice);
check((int)query('SELECT COUNT(*) FROM notification_events')->fetchColumn()===2,'mentions-only filter');
$call=callsHandle('calls.start',['user_id'=>2,'kind'=>'audio','device_id'=>'caller-device'],[],1)['call'];callsHandle('calls.accept',['call_id'=>$call['id'],'device_id'=>'callee-device'],[],2);
try{callsHandle('calls.accept',['call_id'=>$call['id'],'device_id'=>'other-device'],[],2);throw new RuntimeException('Second tab accepted');}catch(ApiError $e){check($e->errorCode==='call_taken','call owner enforced');}
foreach([0,1]as $revision)callsHandle('calls.signal',['call_id'=>$call['id'],'device_id'=>'caller-device','type'=>'offer','negotiation'=>$revision,'payload'=>['type'=>'offer','sdp'=>"v=0\r\ntest-restart-".$revision]],[],1);
check((int)query('SELECT COUNT(*) FROM call_signals')->fetchColumn()===2,'renegotiation safe');callsHandle('calls.end',['call_id'=>$call['id'],'device_id'=>'caller-device'],[],1);
// Exactly one mutable in-chat call record; non-participants see nothing.
check((int)query('SELECT COUNT(*) FROM messages WHERE call_id=?',[$call['id']])->fetchColumn()===1,'one call log');
$log=normalizedMessage(query('SELECT * FROM messages WHERE call_id=?',[$call['id']])->fetch(),2);
check($log['kind']==='call'&&$log['call']['incoming']&&$log['call']['status']==='ended','call metadata in chat');
$second=sendMessage(['conversation_id'=>$direct['id'],'text'=>'Hide only on Bob','client_id'=>'private-hide-test'],$alice);
$cursor=(int)$second['change_seq'];
$_SESSION['user_id']=2;
// Dispatch derives currentUser from a session, so use authenticated API tests for deletion permissions.
transaction(function()use($second):void{query('INSERT INTO message_hidden(user_id,message_id,created_at) VALUES(?,?,?)',[2,$second['id'],time()]);query('UPDATE messages SET change_seq=change_seq WHERE id=?',[$second['id']]);});
check(normalizedMessage(messageFor($second['id'],2,true),2)['hidden'],'personal hidden state');
check(!normalizedMessage(messageFor($second['id'],1,true),1)['hidden'],'other participant content preserved');
check(notificationResolve((int)query('SELECT id FROM notification_events WHERE message_id=? AND user_id=2',[$second['id']])->fetchColumn(),$bob)===null,'hidden push suppressed');
$delta=syncData(['conversation_id'=>$direct['id'],'after_id'=>$second['id'],'after_change_seq'=>$cursor],$bob);
check(count($delta['updated_messages'])===1&&$delta['updated_messages'][0]['hidden'],'delta hide tombstone');
$quiet=syncData(['conversation_id'=>$direct['id'],'after_id'=>$second['id'],'after_change_seq'=>$delta['change_cursor']],$bob);
check($quiet['messages']===[]&&$quiet['updated_messages']===[],'unchanged poll returns no messages');
// Exercise maintained library encryption/VAPID headers through a mocked HTTP client.
$history=[];$stack=GuzzleHttp\HandlerStack::create(new GuzzleHttp\Handler\MockHandler([new GuzzleHttp\Psr7\Response(201)]));$stack->push(GuzzleHttp\Middleware::history($history));
$sender=new Minishlink\WebPush\WebPush(['VAPID'=>['subject'=>'mailto:qa@example.test','publicKey'=>$keys['publicKey'],'privateKey'=>$keys['privateKey']]],[],8,['handler'=>$stack]);
$subscription=Minishlink\WebPush\Subscription::create(array_merge($sub,['contentEncoding'=>'aes128gcm']));$report=$sender->sendOneNotification($subscription,'{"event_id":123,"user_id":2}');check($report->isSuccess(),'encrypted Web Push');$request=$history[0]['request'];check($request->getHeaderLine('Content-Encoding')==='aes128gcm','RFC8291 encoding');check(str_starts_with($request->getHeaderLine('Authorization'),'vapid '),'VAPID authorization');check(!str_contains((string)$request->getBody(),'event_id'),'encrypted wire payload');
echo "PASS: PostgreSQL schema, authorization/privacy/read/DND/mentions, multi-device queue/dedup/leases, endpoint validation/expiry, call ownership and ICE negotiation, RFC8291 encryption and VAPID signing (mock HTTP).\n";
