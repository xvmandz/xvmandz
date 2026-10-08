<?php
declare(strict_types=1);
// Local measurements on an EMPTY migrated pingup_test_* DB. Not a capacity SLA.
require dirname(__DIR__).'/src/bootstrap.php';
require dirname(__DIR__).'/src/actions.php';
if(!str_starts_with((string)query('SELECT current_database()')->fetchColumn(),'pingup_test_')||(int)query('SELECT COUNT(*) FROM users')->fetchColumn()!==0)throw new RuntimeException('Empty test database required.');
transaction(function():void{
    query("INSERT INTO users(username,name,password_hash,last_seen,created_at) VALUES('bench','Bench','test',1,1),('peer','Peer','test',1,1)");
    for($i=0;$i<100;$i++){
        $id=insertId("INSERT INTO conversations(type,name,owner_id,created_at,updated_at) VALUES('group',?,1,1,?)",['Bench '.$i,time()+$i]);
        query('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,1),(?,2)',[$id,$id]);
        query("INSERT INTO messages(conversation_id,sender_id,text,client_id,created_at,updated_at) SELECT ?,2,'Message '||n::text,'bench:'||?::text||':'||n::text,1,1 FROM generate_series(1,50) n",[$id,$id]);
    }
});db()->exec('ANALYZE');
$before=queryCount();$started=hrtime(true);$list=conversationsList(1);$elapsed=(hrtime(true)-$started)/1e6;$queries=queryCount()-$before;
// 2.1 adds privacy, Premium badges and delivery/read cursors: still a constant number of batched queries, independent of chat count.
if(count($list)!==100||$queries>16)throw new RuntimeException('Chat list query count regressed: '.$queries);
echo json_encode(['fixture'=>['chats'=>100,'messages'=>5000],'conversation_list'=>['queries'=>$queries,'milliseconds'=>round($elapsed,2)]],JSON_UNESCAPED_SLASHES).PHP_EOL;
$rows=query('SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 50',[$list[0]['id']])->fetchAll();
$before=queryCount();$started=hrtime(true);$messages=normalizedMessages($rows,1);$elapsed=(hrtime(true)-$started)/1e6;$queries=queryCount()-$before;
if(count($messages)!==50||$queries>5)throw new RuntimeException('Message batch regressed: '.$queries);
echo json_encode(['normalize_50_text_messages'=>['queries'=>$queries,'milliseconds'=>round($elapsed,2)]]).PHP_EOL;
$user=query('SELECT * FROM users WHERE id=1')->fetch();$cursor=(int)max(array_column($rows,'change_seq'));$max=(int)max(array_column($rows,'id'));
$started=hrtime(true);$delta=syncData(['conversation_id'=>$list[0]['id'],'after_id'=>$max,'after_change_seq'=>$cursor],$user);$elapsed=(hrtime(true)-$started)/1e6;
if($delta['messages']!==[]||$delta['updated_messages']!==[])throw new RuntimeException('Unchanged poll must not return message bodies.');
echo json_encode(['unchanged_sync'=>['message_rows'=>0,'milliseconds'=>round($elapsed,2)]]).PHP_EOL;
echo "PASS: bounded batch query counts and empty message deltas. Measurements are one local fixture, not production or Telegram-scale benchmarks.\n";
