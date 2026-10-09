<?php
declare(strict_types=1);

function notificationDefaults(): array {
    return ['sounds'=>true,'message_sound'=>true,'send_sound'=>true,'call_sound'=>true,'volume'=>0.35,'dnd'=>false,'system'=>false,'preview'=>false,'scale'=>'comfortable','motion'=>true,
        // Appearance and personalisation (2.1).
        'theme_name'=>'pingup','accent'=>'#a78bfa','wallpaper'=>'none','font_size'=>15,'radius'=>'default','density'=>'comfortable','list_density'=>'default',
        'time_format'=>'auto','bubble_style'=>'modern','favorite_reactions'=>['❤️','👍','🔥','😂','🥹','✨'],'dismissed_banners'=>[],'enter_to_send'=>true];
}
function notificationSettings(int $userId): array {
    $json=query('SELECT settings FROM notification_settings WHERE user_id=?',[$userId])->fetchColumn();
    return array_replace(notificationDefaults(),$json?json_decode($json,true,16,JSON_THROW_ON_ERROR):[]);
}
/** Stored choice plus the values actually applied: an expired subscription falls back without losing the premium choice. */
function effectiveSettings(array $settings,int $userId): array {
    $premium=premiumActive($userId);
    $settings['premium']=$premium;
    $settings['effective']=[
        'theme_name'=>!$premium&&in_array($settings['theme_name'],PREMIUM_THEMES,true)?'pingup':$settings['theme_name'],
        'wallpaper'=>!$premium&&in_array($settings['wallpaper'],PREMIUM_WALLPAPERS,true)?'none':$settings['wallpaper'],
        'accent'=>!$premium&&in_array($settings['accent'],PREMIUM_ACCENTS,true)?'#a78bfa':$settings['accent'],
    ];
    return $settings;
}
function notificationUpdate(array $input, int $userId): array {return transaction(function()use($input,$userId):array{lockKey('settings:'.$userId);return effectiveSettings(notificationUpdateLocked($input,$userId),$userId);});}
function notificationUpdateLocked(array $input, int $userId): array {
    $settings=notificationSettings($userId);
    unset($settings['premium'],$settings['effective']);
    foreach(['sounds','message_sound','send_sound','call_sound','dnd','system','preview','motion','enter_to_send'] as $key) {
        if(array_key_exists($key,$input)){if(!is_bool($input[$key]))throw new ApiError('invalid_settings');$settings[$key]=$input[$key];}
    }
    if(array_key_exists('volume',$input)) {
        if(!is_numeric($input['volume'])||!is_finite((float)$input['volume']))throw new ApiError('invalid_settings');
        $settings['volume']=max(0,min(1,(float)$input['volume']));
    }
    $enums=['scale'=>['compact','standard','comfortable','large'],'radius'=>['sharp','default','round'],'density'=>['compact','comfortable'],'list_density'=>['compact','default','spacious'],'time_format'=>['auto','24','12'],'bubble_style'=>['modern','classic','minimal'],
        'theme_name'=>array_merge(FREE_THEMES,PREMIUM_THEMES),'wallpaper'=>array_merge(FREE_WALLPAPERS,PREMIUM_WALLPAPERS),'accent'=>array_merge(FREE_ACCENTS,PREMIUM_ACCENTS)];
    foreach($enums as $key=>$allowed) {
        if(!array_key_exists($key,$input))continue;
        $value=is_string($input[$key])?strtolower($input[$key]):$input[$key];
        if(!in_array($value,$allowed,true))throw new ApiError('invalid_settings');
        $premiumOnly=in_array($value,PREMIUM_THEMES,true)||in_array($value,PREMIUM_WALLPAPERS,true)||in_array($value,PREMIUM_ACCENTS,true);
        if($premiumOnly&&!premiumActive($userId))throw new ApiError('premium_required',402);
        $settings[$key]=$value;
    }
    if(array_key_exists('font_size',$input)){
        if(!is_int($input['font_size'])||$input['font_size']<13||$input['font_size']>20)throw new ApiError('invalid_settings');
        $settings['font_size']=$input['font_size'];
    }
    if(array_key_exists('favorite_reactions',$input)){
        if(!is_array($input['favorite_reactions'])||!array_is_list($input['favorite_reactions'])||count($input['favorite_reactions'])>8)throw new ApiError('invalid_settings');
        $settings['favorite_reactions']=array_values(array_unique(array_map('reactionValue',$input['favorite_reactions'])));
    }
    if(array_key_exists('dismiss_banner',$input)){
        if(!is_string($input['dismiss_banner'])||!preg_match('/^[a-z_]{3,32}$/D',$input['dismiss_banner']))throw new ApiError('invalid_settings');
        $settings['dismissed_banners']=array_values(array_unique(array_slice(array_merge($settings['dismissed_banners'],[$input['dismiss_banner']]),-20)));
    }
    query('INSERT INTO notification_settings(user_id,settings) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET settings=excluded.settings',[$userId,json_encode($settings,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE)]);
    return $settings;
}
function notificationEnqueue(int $userId,string $kind,?int $messageId=null,?int $callId=null): void {
    $key=($messageId?'message:'.$messageId:'call:'.$callId);
    query('INSERT INTO notification_events(user_id,kind,message_id,call_id,dedup_key,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',[$userId,$kind,$messageId,$callId,$key,time()]);
    $id=(int)query('SELECT id FROM notification_events WHERE user_id=? AND dedup_key=?',[$userId,$key])->fetchColumn();
    query("INSERT INTO push_deliveries(event_id,subscription_id,available_at) SELECT ?,id,? FROM push_subscriptions WHERE user_id=? AND expires_at>? ON CONFLICT DO NOTHING",[$id,time()+2,$userId,time()]);
}
function notificationMessage(array $message): void {
    preg_match_all('/(?<![\pL\pN_])@([a-zA-Z0-9_]{3,32})(?![\pL\pN_])/u',$message['text'],$matches);
    $mentioned=array_values(array_unique(array_map('strtolower',$matches[1])));
    $mention=$mentioned?'u.username IN ('.placeholders($mentioned).')':'FALSE';
    $params=array_merge($mentioned,[(int)$message['id'],'message:'.$message['id'],time(),(int)$message['conversation_id'],(int)$message['sender_id']],$mentioned,[time()+2,time()]);
    // One set-based fanout, not three queries for every subscriber. Delivery stays asynchronous.
    query("WITH recipients AS (
      INSERT INTO notification_events(user_id,kind,message_id,dedup_key,created_at)
      SELECT u.id,CASE WHEN ".$mention." THEN 'mention' ELSE 'message' END,?,?,?
      FROM conversation_members cm JOIN users u ON u.id=cm.user_id
      WHERE cm.conversation_id=? AND u.id<>? AND cm.notification_mode<>'none'
      AND (cm.notification_mode='all' OR ".$mention.")
      ON CONFLICT DO NOTHING RETURNING id,user_id
    ) INSERT INTO push_deliveries(event_id,subscription_id,available_at)
      SELECT e.id,s.id,? FROM recipients e JOIN push_subscriptions s ON s.user_id=e.user_id WHERE s.expires_at>?
      ON CONFLICT DO NOTHING",$params);
}

function pushVapid(): ?array {
    $path=config()['vapid_file'];
    if(!is_file($path))return null;
    $keys=json_decode(file_get_contents($path),true,8,JSON_THROW_ON_ERROR);
    return isset($keys['publicKey'],$keys['privateKey'])?$keys:null;
}
function pushAvailable(): bool {return is_file(dirname(__DIR__).'/vendor/autoload.php')&&pushVapid()!==null&&str_starts_with(config()['app_origin']??'','https://');}
function pushDecode(string $text): string {
    if(!preg_match('/^[A-Za-z0-9_-]+$/D',$text))throw new ApiError('invalid_subscription');
    $decoded=base64_decode(strtr($text,'-_','+/').str_repeat('=',(4-strlen($text)%4)%4),true);
    if($decoded===false)throw new ApiError('invalid_subscription');return $decoded;
}
function pushEndpoint(string $endpoint): void {
    $url=parse_url($endpoint);
    if(!$url||($url['scheme']??'')!=='https'||isset($url['user'])||isset($url['pass'])||isset($url['fragment'])||isset($url['port'])&&$url['port']!==443)throw new ApiError('invalid_subscription');
    $host=strtolower($url['host']??'');$allowed=false;
    foreach(config()['push_hosts'] as $domain)if($host===$domain||str_ends_with($host,'.'.$domain))$allowed=true;
    if(!$allowed)throw new ApiError('push_provider_unsupported');
}
function pushSubscribe(array $input,array $user): array {
    rateLimit('push_subscribe',20,3600,(string)$user['id']);
    if(!pushAvailable())throw new ApiError('push_not_configured',503);
    $endpoint=textValue($input['endpoint']??'',4096,1);pushEndpoint($endpoint);
    $p256dh=textValue($input['keys']['p256dh']??'',200,1);$auth=textValue($input['keys']['auth']??'',100,1);
    $public=pushDecode($p256dh);if(strlen($public)!==65||$public[0]!=="\x04"||strlen(pushDecode($auth))!==16)throw new ApiError('invalid_subscription');
    return transaction(function()use($endpoint,$p256dh,$auth,$user):array {
        $hash=hash('sha256',$endpoint);$old=query('SELECT * FROM push_subscriptions WHERE endpoint_hash=?',[$hash])->fetch();
        if($old&&(int)$old['user_id']!==(int)$user['id'])throw new ApiError('subscription_conflict',409);
        if(!$old&&(int)query('SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?',[$user['id']])->fetchColumn()>=10)throw new ApiError('device_limit',429);
        $now=time();query('INSERT INTO push_subscriptions(user_id,endpoint,endpoint_hash,p256dh,auth,session_hash,session_version,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,session_hash=excluded.session_hash,session_version=excluded.session_version,expires_at=excluded.expires_at,updated_at=excluded.updated_at',[$user['id'],$endpoint,$hash,$p256dh,$auth,hash('sha256',session_id()),$user['session_version'],$now+86400,$now,$now]);
        return ['subscribed'=>true];
    });
}
function notificationResolve(int $eventId,array $user): ?array {
    $event=query('SELECT * FROM notification_events WHERE id=? AND user_id=?',[$eventId,$user['id']])->fetch();
    if(!$event)return null;
    $settings=notificationSettings((int)$user['id']);if($settings['dnd'])return null;
    $dict=localeDictionary($user['locale']);
    $t=static fn(string $key):string=>$dict[$key]??$key;
    if($event['message_id']) {
        $message=query('SELECT m.*,cm.last_read_message_id,cm.notification_mode,c.type,c.name AS conversation_name FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND cm.user_id=?',[$event['message_id'],$user['id']])->fetch();
        if(!$message||hiddenMessage((int)$message['id'],(int)$user['id'])||$message['deleted']||(int)$message['sender_id']===(int)$user['id']||($message['thread_root_id']===null&&(int)$message['last_read_message_id']>=(int)$message['id'])||isBlocked((int)$user['id'],(int)$message['sender_id'])||$message['notification_mode']==='none'||$message['notification_mode']==='mentions'&&$event['kind']!=='mention')return null;
        $sender=query('SELECT name FROM users WHERE id=?',[$message['sender_id']])->fetchColumn();
        $body=$t('notify.new_message');
        if($settings['preview']) {
            $file=$message['file_id']?query('SELECT mime FROM files WHERE id=?',[$message['file_id']])->fetchColumn():null;
            $body=match(true){$message['kind']==='voice'=>$t('notify.voice'),$message['kind']==='sticker'=>$t('notify.sticker'),$message['kind']==='poll'=>$t('notify.poll'),$message['kind']==='album'=>$t('notify.album'),(bool)$file=>str_starts_with($file,'image/')?$t('notify.photo'):(str_starts_with($file,'video/')?$t('notify.video'):$t('notify.file')),default=>mb_substr($message['text'],0,180)};
            if($message['thread_root_id']!==null)$body=$t('notify.comment').': '.$body;
        }
        return ['event_id'=>(int)$event['id'],'kind'=>$event['kind'],'conversation_id'=>(int)$message['conversation_id'],'title'=>$sender.($message['type']==='direct'?'':' · '.$message['conversation_name']),'body'=>$body,'tag'=>'pingup-event-'.$event['id'],'silent'=>!$settings['sounds']||!$settings['message_sound'],'url'=>rtrim(config()['app_url'],'/').'/?chat='.$message['conversation_id'],'created_at'=>(int)$event['created_at']];
    }
    $base=rtrim(config()['app_url'],'/');
    if($event['kind']==='feedback'){
        $ticket=query('SELECT id,status,title FROM feedback_tickets WHERE id=? AND user_id=?',[$event['feedback_ticket_id'],$user['id']])->fetch();
        if(!$ticket)return null;
        // Private ticket content appears only when the user enabled message previews.
        $reason=explode(':',$event['dedup_key'])[1]??'reply';
        $body=$t('notify.feedback_'.$reason);
        if($settings['preview'])$body.=' · '.mb_substr($ticket['title'],0,120);
        return ['event_id'=>(int)$event['id'],'kind'=>'feedback','ticket_id'=>(int)$ticket['id'],'title'=>$t('feedback.notify_title')." #".$ticket['id'],'body'=>$body,'tag'=>'pingup-feedback-'.$ticket['id'],'silent'=>!$settings['sounds'],'url'=>$base.'/?feedback='.$ticket['id'],'created_at'=>(int)$event['created_at']];
    }
    if($event['kind']==='contact'){
        $actor=query('SELECT id,name FROM users WHERE id=?',[$event['actor_id']])->fetch();
        if(!$actor||isBlocked((int)$user['id'],(int)$actor['id']))return null;
        $accepted=str_starts_with($event['dedup_key'],'contact:accepted:');
        return ['event_id'=>(int)$event['id'],'kind'=>'contact','user_id'=>(int)$actor['id'],'title'=>$actor['name'],'body'=>$t($accepted?'contacts.notify_accepted':'contacts.notify_request'),'tag'=>'pingup-contact-'.$actor['id'],'silent'=>!$settings['sounds'],'url'=>$base.'/?contacts=1','created_at'=>(int)$event['created_at']];
    }
    $call=query('SELECT * FROM calls WHERE id=? AND callee_id=? AND status=?',[$event['call_id'],$user['id'],'ringing'])->fetch();
    if(!$call)return null;
    $sender=query('SELECT name FROM users WHERE id=?',[$call['caller_id']])->fetchColumn();
    return ['event_id'=>(int)$event['id'],'kind'=>'call','call_id'=>(int)$call['id'],'title'=>$sender,'body'=>$t('calls.incoming'),'tag'=>'pingup-event-'.$event['id'],'silent'=>!$settings['sounds']||!$settings['call_sound'],'url'=>rtrim(config()['app_url'],'/').'/?call='.$call['id'],'accept'=>$t('calls.accept'),'decline'=>$t('calls.decline'),'created_at'=>(int)$event['created_at']];
}
function notificationsList(array $input,array $user): array {
    $after=intValue($input['after_event_id']??0,0);
    $rows=query('SELECT id FROM notification_events WHERE user_id=? AND id>? ORDER BY id LIMIT 100',[$user['id'],$after])->fetchAll();
    $events=[];$cursor=$after;
    foreach($rows as $row){$cursor=(int)$row['id'];$event=notificationResolve($cursor,$user);if($event)$events[]=$event;}
    return ['events'=>$events,'event_cursor'=>$cursor,'settings'=>effectiveSettings(notificationSettings((int)$user['id']),(int)$user['id'])];
}
function notificationsHandle(string $action,array $input,array $user): mixed {
    rateLimit('notifications_api',240,60,(string)$user['id']);
    switch($action) {
      case 'notifications.settings':return notificationUpdate($input,(int)$user['id']);
      case 'notifications.resolve':if(!empty($input['system'])&&!notificationSettings((int)$user['id'])['system'])return null;return notificationResolve(intValue($input['event_id']??null),$user);
      case 'notifications.list':return notificationsList($input,$user);
      case 'notifications.chat':
        $id=intValue($input['conversation_id']??null);conversationFor($id,(int)$user['id']);
        $mode=$input['mode']??'';if(!in_array($mode,['all','mentions','none'],true))throw new ApiError('invalid_settings');
        query('UPDATE conversation_members SET notification_mode=? WHERE conversation_id=? AND user_id=?',[$mode,$id,$user['id']]);return ['mode'=>$mode];
      case 'push.subscribe':return pushSubscribe($input,$user);
      case 'push.unsubscribe':
        $endpoint=textValue($input['endpoint']??'',4096,1);
        query('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint_hash=?',[$user['id'],hash('sha256',$endpoint)]);return ['subscribed'=>false];
      case 'push.status':return ['enabled'=>pushAvailable(),'public_key'=>pushAvailable()?pushVapid()['publicKey']:null,'devices'=>(int)query('SELECT COUNT(*) FROM push_subscriptions WHERE user_id=? AND expires_at>?',[$user['id'],time()])->fetchColumn()];
    }
    throw new ApiError('invalid_action',404);
}
