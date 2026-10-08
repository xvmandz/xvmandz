#!/usr/bin/env php
<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/src/bootstrap.php';
require dirname(__DIR__).'/vendor/autoload.php';
$path=config()['vapid_file'];
if(is_file($path)){fwrite(STDERR,"VAPID keys already exist; rotation requires a separate migration of browser subscriptions.\n");exit(1);}
$keys=Minishlink\WebPush\VAPID::createVapidKeys();
$old=umask(0077);$file=fopen($path,'x');if(!$file)throw new RuntimeException('Cannot create private VAPID file');
fwrite($file,json_encode($keys,JSON_THROW_ON_ERROR));fclose($file);chmod($path,0600);umask($old);
echo "VAPID keys generated in private storage. No keys printed.\n";
