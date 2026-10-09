<?php
declare(strict_types=1);

function pushClaim(): ?array {
    return transaction(function():?array {
        $row=query("SELECT d.* FROM push_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE (d.status='queued' AND d.available_at<=?) OR (d.status='processing' AND d.lease_until<?) ORDER BY CASE WHEN e.kind='call' THEN 0 ELSE 1 END,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED",[time(),time()])->fetch();
        if(!$row)return null;
        query("UPDATE push_deliveries SET status='processing',lease_until=?,attempts=attempts+1 WHERE id=?",[time()+300,$row['id']]);$row['attempts']++;return $row;
    });
}
function pushDeliver(array $job, callable $transport): string {
    if($job['attempts']>4){query("UPDATE push_deliveries SET status='failed',lease_until=0,error_code='attempt_limit' WHERE id=?",[$job['id']]);return 'failed';}
    $sub=query('SELECT s.*,u.session_version AS current_version FROM push_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.id=?',[$job['subscription_id']])->fetch();
    $settings=$sub?notificationSettings((int)$sub['user_id']):null;
    $user=$sub?query('SELECT * FROM users WHERE id=?',[$sub['user_id']])->fetch():null;
    $event=$user?notificationResolve((int)$job['event_id'],$user):null;
    if(!$sub||(int)$sub['expires_at']<=time()||(int)$sub['session_version']!==(int)$sub['current_version']||!$settings['system']||!$event||time()-$event['created_at']>3600){
        query("UPDATE push_deliveries SET status='cancelled',lease_until=0 WHERE id=?",[$job['id']]);return 'cancelled';
    }
    try {$result=$transport($sub,['event_id'=>(int)$job['event_id'],'user_id'=>(int)$sub['user_id']],$event['kind']==='call'?45:3600);}catch(Throwable){$result=['success'=>false,'expired'=>false,'code'=>'transport'];}
    if($result['expired']??false){query('DELETE FROM push_subscriptions WHERE id=?',[$sub['id']]);return 'expired';}
    $success=$result['success']??false;
    $status=$success?'sent':($job['attempts']>=4?'failed':'queued');
    $code=$success?null:substr(preg_replace('/[^a-zA-Z0-9_-]/','',(string)($result['code']??'transport')),0,40);
    query('UPDATE push_deliveries SET status=?,lease_until=0,available_at=?,error_code=? WHERE id=?',[$status,time()+min(300,10*2**$job['attempts']),$code,$job['id']]);return $status;
}
