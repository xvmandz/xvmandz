#!/usr/bin/env php
<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/src/bootstrap.php';
require dirname(__DIR__).'/src/actions.php';
// Delivers the e-mail outbox through the SMTP server from config.local.php. Use --once from cron or run as a service.
$once=in_array('--once',$argv,true);
$lock=fopen(config()['storage_path'].'/mail-worker.lock','c');
if(!$lock||!flock($lock,LOCK_EX|LOCK_NB)){fwrite(STDERR,"Another mail worker is running.\n");exit(0);}
if(!smtpConfigured()){fwrite(STDERR,"SMTP is not configured (smtp_host/mail_from in config.local.php). Mail stays queued.\n");exit($once?0:1);}
do{
    try{$stats=mailDeliver(20);if(array_sum($stats))fwrite(STDOUT,date('c')." sent={$stats['sent']} retry={$stats['retry']} failed={$stats['failed']}\n");}
    catch(Throwable $error){fwrite(STDERR,'Mail worker error: '.get_class($error)."\n");}
    if(!$once)sleep(5);
}while(!$once);
