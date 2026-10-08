#!/usr/bin/env php
<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/src/bootstrap.php';
require dirname(__DIR__).'/src/Calls.php';
$options=getopt('',['source:']);$path=$options['source']??'';
if(!is_string($path)||!is_file($path)){fwrite(STDERR,"Usage: php bin/import-sqlite.php --source=/private/backup/pingup.sqlite\n");exit(1);}
$tables=['users','files','conversations','conversation_members','messages','reactions','typing','rate_limits','calls','call_signals','notification_settings','notification_events','push_subscriptions','push_deliveries'];
try{
    $source=new PDO('sqlite:'.$path,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    $source->exec('PRAGMA query_only=ON');$source->beginTransaction();
    if((int)$source->query('PRAGMA user_version')->fetchColumn()!==3)throw new RuntimeException('Upgrade the source copy with PingUp 1.1 first (schema 3 required).');
    $counts=transaction(function()use($source,$tables):array{
        lockKey('schema-migration');
        if((int)query('SELECT MAX(version) FROM schema_migrations')->fetchColumn()!==4)throw new RuntimeException('Run bin/migrate.php first.');
        db()->exec('LOCK TABLE '.implode(',',$tables).',message_hidden IN ACCESS EXCLUSIVE MODE');
        foreach($tables as $table)if((int)query('SELECT COUNT(*) FROM '.$table)->fetchColumn()!==0)throw new RuntimeException('Target must be empty; import never overwrites data.');
        db()->exec('SET CONSTRAINTS ALL DEFERRED');
        $counts=[];
        foreach($tables as $table){
            $cols=array_column($source->query('PRAGMA table_info('.$table.')')->fetchAll(),'name');
            $statement=db()->prepare('INSERT INTO '.$table.'('.implode(',',$cols).') VALUES('.placeholders($cols).')');
            $rows=$source->query('SELECT * FROM '.$table);$count=0;
            while($row=$rows->fetch()){$statement->execute(array_values($row));$count++;}
            if((int)query('SELECT COUNT(*) FROM '.$table)->fetchColumn()!==$count)throw new RuntimeException('Row verification failed.');
            $counts[$table]=$count;
            if(in_array('id',$cols,true))query("SELECT setval(pg_get_serial_sequence(?, 'id'),GREATEST(COALESCE((SELECT MAX(id) FROM ".$table."),0),1),(SELECT COUNT(*)>0 FROM ".$table."))",[$table]);
        }
        foreach(query("SELECT id FROM conversations WHERE type='channel' AND invite_token IS NULL")->fetchAll() as $channel)query('UPDATE conversations SET invite_token=? WHERE id=?',[bin2hex(random_bytes(24)),$channel['id']]);
        // Preserve identifiers/password hashes/session versions; historical calls get one chat entry.
        foreach(query('SELECT * FROM calls ORDER BY id')->fetchAll() as $call)callRecord($call);
        return $counts;
    });
    $source->rollBack();db()->exec('ANALYZE');
    foreach($counts as $table=>$count)echo $table.': '.$count." imported\n";
    echo "Import committed. Source database unchanged. Keep uploads, session storage and VAPID keys separately.\n";
}catch(Throwable $error){if(isset($source)&&$source->inTransaction())$source->rollBack();fwrite(STDERR,'Import failed: '.get_class($error).' code='.$error->getCode().". No target rows committed. Check source schema and empty target.\n");exit(1);}
