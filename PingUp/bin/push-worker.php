#!/usr/bin/env php
<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require dirname(__DIR__).'/src/bootstrap.php';
require dirname(__DIR__).'/src/PushWorker.php';
require dirname(__DIR__).'/vendor/autoload.php';
if(!pushAvailable())throw new RuntimeException('Configure HTTPS app_origin and private VAPID keys first.');
$lock=fopen(config()['storage_path'].'/push-worker.lock','c');
if(!$lock||!flock($lock,LOCK_EX|LOCK_NB)){fwrite(STDERR,"A push worker is already running.\n");exit(1);}
$keys=pushVapid();$sender=new Minishlink\WebPush\WebPush(['VAPID'=>['subject'=>config()['vapid_subject'],'publicKey'=>$keys['publicKey'],'privateKey'=>$keys['privateKey']]],['TTL'=>3600,'urgency'=>'normal'],8);
$once=in_array('--once',$argv,true);$running=true;
if(function_exists('pcntl_async_signals')){pcntl_async_signals(true);pcntl_signal(SIGTERM,static function()use(&$running):void{$running=false;});pcntl_signal(SIGINT,static function()use(&$running):void{$running=false;});}
$send=static function(array $sub,array $payload,int $ttl)use($sender):array{
    $subscription=Minishlink\WebPush\Subscription::create(['endpoint'=>$sub['endpoint'],'keys'=>['p256dh'=>$sub['p256dh'],'auth'=>$sub['auth']],'contentEncoding'=>'aes128gcm']);
    $report=$sender->sendOneNotification($subscription,json_encode($payload,JSON_THROW_ON_ERROR),['TTL'=>$ttl,'urgency'=>$ttl===45?'high':'normal']);
    return ['success'=>$report->isSuccess(),'expired'=>$report->isSubscriptionExpired(),'code'=>(string)($report->getResponse()?->getStatusCode()??'transport')];
};
do {
    $processed=0;
    while($running&&$processed++<20&&($job=pushClaim())) {
        $status=pushDeliver($job,$send);echo 'Push job '.$job['id'].': '.$status.PHP_EOL;
    }
    if(!$once&&$running)usleep(500000);
}while(!$once&&$running);
