#!/usr/bin/env php
<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/src/bootstrap.php';
// Schema 4 is the 2.0 base; numbered files in database/migrations upgrade it incrementally.
try {
    $version=transaction(function():int{
        lockKey('schema-migration');
        $exists=query("SELECT to_regclass('public.schema_migrations')")->fetchColumn();
        if(!$exists){
            if(query("SELECT to_regclass('public.users')")->fetchColumn())throw new RuntimeException('Target database is not empty.');
            db()->exec(file_get_contents(dirname(__DIR__).'/database/postgresql.sql'));
        }
        $current=(int)query('SELECT MAX(version) FROM schema_migrations')->fetchColumn();
        if($current<4||$current>PINGUP_SCHEMA_VERSION)throw new RuntimeException('Unsupported schema version '.$current.'.');
        foreach(glob(dirname(__DIR__).'/database/migrations/*.sql') as $file){
            $number=(int)basename($file);
            if($number<=$current)continue;
            db()->exec(file_get_contents($file));
            query('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)',[$number,time()]);
            fwrite(STDOUT,'Applied migration '.basename($file)."\n");
            $current=$number;
        }
        if($current!==PINGUP_SCHEMA_VERSION)throw new RuntimeException('Migration files are incomplete.');
        return $current;
    });
    echo "PostgreSQL schema {$version} ready.\n";
}catch(Throwable $error){fwrite(STDERR,'Migration failed: '.get_class($error).' code='.$error->getCode().' '.$error->getMessage().". Target was rolled back; check database configuration.\n");exit(1);}
