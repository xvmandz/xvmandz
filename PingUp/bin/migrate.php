#!/usr/bin/env php
<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/src/bootstrap.php';
try {
    transaction(function():void{
        lockKey('schema-migration');
        $exists=query("SELECT to_regclass('public.schema_migrations')")->fetchColumn();
        if(!$exists){
            if(query("SELECT to_regclass('public.users')")->fetchColumn())throw new RuntimeException('Target database is not empty.');
            db()->exec(file_get_contents(dirname(__DIR__).'/database/postgresql.sql'));
        }elseif((int)query('SELECT MAX(version) FROM schema_migrations')->fetchColumn()!==4)throw new RuntimeException('Unsupported schema version.');
    });
    echo "PostgreSQL schema 4 ready.\n";
}catch(Throwable $error){fwrite(STDERR,'Migration failed: '.get_class($error).' code='.$error->getCode().". Target was rolled back; check database configuration.\n");exit(1);}
