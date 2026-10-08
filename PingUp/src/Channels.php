<?php
declare(strict_types=1);
function channelSlug(mixed $value): ?string {
    if($value===null||$value==='')return null;
    if(!is_string($value))throw new ApiError('invalid_channel_slug');
    $value=strtolower(trim($value));
    if(!preg_match('/^[a-z][a-z0-9_]{4,31}$/D',$value))throw new ApiError('invalid_channel_slug');
    return $value;
}
function channelsHandle(string $action,array $input,array $user): array {
    $uid=(int)$user['id'];
    rateLimit('channels',60,60,(string)$uid);
    if($action==='channels.search'){
        $search=textValue($input['q']??'',80);
        $search='%'.str_replace(['\\','%','_'],['\\\\','\\%','\\_'],$search).'%';
        $rows=query("SELECT c.id,c.name,c.description,c.slug,c.avatar_file_id,COUNT(cm.user_id) AS member_count,MAX(CASE WHEN cm.user_id=? THEN 1 ELSE 0 END) AS joined FROM conversations c LEFT JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.type='channel' AND c.visibility='public' AND (c.name ILIKE ? OR c.slug ILIKE ?) GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 50",[$uid,$search,$search])->fetchAll();
        return ['channels'=>array_map(static fn($row)=>['id'=>(int)$row['id'],'name'=>$row['name'],'description'=>$row['description'],'slug'=>$row['slug'],'avatar_url'=>$row['avatar_file_id']?'media.php?id='.$row['avatar_file_id']:null,'member_count'=>(int)$row['member_count'],'joined'=>(bool)$row['joined']],$rows)];
    }
    if($action==='channels.join'){
        $id=transaction(function()use($input,$uid):int{
            if(!empty($input['invite_token'])){
                $token=textValue($input['invite_token'],64,32);
                $channel=query("SELECT * FROM conversations WHERE type='channel' AND invite_token=? FOR UPDATE",[$token])->fetch();
            }else{
                $slug=channelSlug($input['slug']??null);
                if(!$slug)throw new ApiError('invalid_channel_slug');
                $channel=query("SELECT * FROM conversations WHERE type='channel' AND visibility='public' AND slug=? FOR UPDATE",[$slug])->fetch();
            }
            if(!$channel)throw new ApiError('channel_not_found',404);
            query('INSERT INTO conversation_members(conversation_id,user_id,last_read_message_id) VALUES(?,?,COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=?),0)) ON CONFLICT DO NOTHING',[$channel['id'],$uid,$channel['id']]);
            return (int)$channel['id'];
        });
        return normalizedConversation(conversationFor($id,$uid),$uid);
    }
    $id=intValue($input['conversation_id']??null);
    $channel=conversationFor($id,$uid);
    if($channel['type']!=='channel')throw new ApiError('channel_not_found',404);
    if($action==='channels.leave'){
        if((int)$channel['owner_id']===$uid)throw new ApiError('channel_owner_cannot_leave',403);
        query('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?',[$id,$uid]);
        return ['left'=>true,'conversation_id'=>$id];
    }
    if((int)$channel['owner_id']!==$uid)throw new ApiError('channel_owner_only',403);
    transaction(function()use($id,$uid,$input):void{
        $channel=query('SELECT * FROM conversations WHERE id=? FOR UPDATE',[$id])->fetch();
        $updates=[];$values=[];
        foreach(['name'=>80,'description'=>500] as $key=>$max)if(array_key_exists($key,$input)){$updates[]=$key.'=?';$values[]=textValue($input[$key],$max,$key==='name'?1:0);}
        $slug=array_key_exists('slug',$input)?channelSlug($input['slug']):$channel['slug'];
        $visibility=$input['visibility']??$channel['visibility'];
        if(!in_array($visibility,['public','private'],true)||$visibility==='public'&&!$slug)throw new ApiError('invalid_channel_slug');
        if(array_key_exists('slug',$input)){$updates[]='slug=?';$values[]=$slug;}
        if(array_key_exists('visibility',$input)){$updates[]='visibility=?';$values[]=$visibility;}
        if(!empty($input['rotate_invite'])){$updates[]='invite_token=?';$values[]=bin2hex(random_bytes(24));}
        if(array_key_exists('avatar_file_id',$input)){
            $file=$input['avatar_file_id']?intValue($input['avatar_file_id']):null;
            if($file&&!query("SELECT id FROM files WHERE id=? AND owner_id=? AND mime IN ('image/png','image/jpeg','image/webp','image/gif')",[$file,$uid])->fetchColumn())throw new ApiError('invalid_avatar');
            $updates[]='avatar_file_id=?';$values[]=$file;
        }
        if($updates){$updates[]='updated_at=?';$values[]=time();$values[]=$id;try{query('UPDATE conversations SET '.implode(',',$updates).' WHERE id=?',$values);}catch(PDOException $error){if($error->getCode()==='23505')throw new ApiError('channel_slug_taken',409);throw $error;}}
        foreach(['add_user_ids','remove_user_ids'] as $mode){
            $list=$input[$mode]??[];
            if(!is_array($list)||!array_is_list($list)||count($list)>100)throw new ApiError('invalid_members');
            foreach(array_unique($list) as $value){
                $member=intValue($value);
                if($mode==='add_user_ids'){
                    if(!query('SELECT id FROM users WHERE id=?',[$member])->fetchColumn())throw new ApiError('invalid_members');
                    query('INSERT INTO conversation_members(conversation_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING',[$id,$member]);
                }elseif($member!==$uid)query('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?',[$id,$member]);
            }
        }
    });
    return normalizedConversation(conversationFor($id,$uid),$uid);
}
