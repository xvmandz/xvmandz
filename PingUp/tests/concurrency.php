<?php
declare(strict_types=1);
// This helper is orchestrated by concurrency.py, never against production.
require dirname(__DIR__).'/src/bootstrap.php';require dirname(__DIR__).'/src/actions.php';require dirname(__DIR__).'/src/Calls.php';
if(!str_starts_with((string)query('SELECT current_database()')->fetchColumn(),'pingup_test_'))throw new RuntimeException('Disposable test DB required.');
$mode=$argv[1]??'';
if($mode==='seed'){
    if((int)query('SELECT COUNT(*) FROM users')->fetchColumn()!==0)throw new RuntimeException('Empty test DB required.');
    query("INSERT INTO users(username,name,password_hash,last_seen,created_at) VALUES('alice','Alice','test',1,1),('bob','Bob','test',1,1),('carol','Carol','test',1,1)");
    echo json_encode(conversationsCreate(['type'=>'direct','user_id'=>2],query('SELECT * FROM users WHERE id=1')->fetch()));exit;
}
if($mode==='proof'){
    $message=query("SELECT * FROM messages WHERE client_id='concurrent-client-id'")->fetch();
    if(!$message||(int)query("SELECT COUNT(*) FROM messages WHERE client_id='concurrent-client-id'")->fetchColumn()!==1||(int)query('SELECT COUNT(*) FROM notification_events WHERE message_id=?',[$message['id']])->fetchColumn()!==1)throw new RuntimeException('Idempotency failure');
    if((int)query("SELECT COUNT(*) FROM calls WHERE status='ringing'")->fetchColumn()!==1)throw new RuntimeException('Busy guard failure');
    echo "PASS: concurrent connections create one message/notification and only one competing call.\n";exit;
}
$gate=$argv[2]??'';$ready=$argv[3]??'';
if(!str_starts_with($gate,sys_get_temp_dir().'/pingup-concurrency-'))throw new RuntimeException('Invalid test gate');
file_put_contents($ready,'ready');$deadline=microtime(true)+5;while(!is_file($gate)){if(microtime(true)>$deadline)throw new RuntimeException('Gate timeout');usleep(10000);}
try{
    if($mode==='send'){$result=sendMessage(['conversation_id'=>1,'text'=>'Concurrent delivery','client_id'=>'concurrent-client-id'],query('SELECT * FROM users WHERE id=1')->fetch());echo json_encode(['id'=>$result['id']]);}
    elseif($mode==='call'){$uid=(int)$argv[4];$result=callsHandle('calls.start',['user_id'=>2,'kind'=>'audio','device_id'=>'concurrency-device-'.$uid],[],$uid);echo json_encode(['id'=>$result['call']['id']]);}
}catch(ApiError $error){echo json_encode(['error'=>$error->errorCode]);}
