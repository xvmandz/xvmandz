<?php
declare(strict_types=1);

// Communities: channels and groups. Appearance, roles, bans, invite links, audit, analytics.

const COMMUNITY_PRESETS = ['minimal', 'dark_neon', 'glass', 'gradient', 'classic', 'community', 'gaming', 'business'];
const COMMUNITY_CATEGORIES = ['news', 'tech', 'gaming', 'music', 'education', 'business', 'community', 'art', 'sport', 'other'];
const COMMUNITY_LANGUAGES = ['uk', 'ru', 'en', 'other'];
const COMMUNITY_CARD_STYLES = ['flat', 'elevated', 'outlined', 'glass'];

function channelSlug(mixed $value): ?string {
    if($value===null||$value==='')return null;
    if(!is_string($value))throw new ApiError('invalid_channel_slug');
    $value=strtolower(trim($value));
    if(!preg_match('/^[a-z][a-z0-9_]{4,31}$/D',$value))throw new ApiError('invalid_channel_slug');
    return $value;
}

function hexColor(mixed $value): ?string
{
    if ($value === null || $value === '') return null;
    if (!is_string($value) || !preg_match('/^#[0-9a-fA-F]{6}$/D', $value)) throw new ApiError('invalid_color');
    return strtolower($value);
}

function communityAudit(int $conversationId, int $actorId, string $action, ?int $target = null, array $details = []): void
{
    query('INSERT INTO conversation_audit(conversation_id,actor_id,action,target_user_id,details,created_at) VALUES(?,?,?,?,?,?)', [$conversationId, $actorId, $action, $target, json_encode($details, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), time()]);
}

function statsBump(int $conversationId, string $field, int $amount = 1): void
{
    if (!in_array($field, ['joins', 'leaves', 'views'], true) || $amount <= 0) return;
    query("INSERT INTO channel_stats_daily(conversation_id,day,$field) VALUES(?,CURRENT_DATE,?) ON CONFLICT(conversation_id,day) DO UPDATE SET $field=channel_stats_daily.$field+excluded.$field", [$conversationId, $amount]);
}

/** Validates appearance/behaviour settings. Unknown keys are rejected rather than stored. */
function communitySettingsInput(array $input, array $current, string $type): array
{
    $settings = $current;
    foreach ($input as $key => $value) {
        switch ($key) {
            case 'preset':
                if (!in_array($value, COMMUNITY_PRESETS, true)) throw new ApiError('invalid_settings');
                $settings[$key] = $value;
                break;
            case 'accent': case 'header_color': case 'background': case 'button_color':
                $settings[$key] = hexColor($value);
                break;
            case 'gradient':
                if ($value === null) { $settings[$key] = null; break; }
                if (!is_array($value)) throw new ApiError('invalid_settings');
                $angle = $value['angle'] ?? 135;
                if (!is_int($angle) || $angle < 0 || $angle > 360) throw new ApiError('invalid_settings');
                $settings[$key] = ['from' => hexColor($value['from'] ?? null) ?? throw new ApiError('invalid_color'), 'to' => hexColor($value['to'] ?? null) ?? throw new ApiError('invalid_color'), 'angle' => $angle];
                break;
            case 'card_style':
                if (!in_array($value, COMMUNITY_CARD_STYLES, true)) throw new ApiError('invalid_settings');
                $settings[$key] = $value;
                break;
            case 'welcome':
                $settings[$key] = textValue($value, 500);
                break;
            case 'tagline':
                $settings[$key] = textValue($value, 120);
                break;
            case 'links':
                if (!is_array($value) || !array_is_list($value) || count($value) > 5) throw new ApiError('invalid_links');
                $settings[$key] = array_map(function ($link): array {
                    if (!is_array($link)) throw new ApiError('invalid_links');
                    $url = textValue($link['url'] ?? '', 300, 8);
                    $parts = parse_url($url);
                    if (!$parts || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true) || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) throw new ApiError('invalid_links');
                    return ['title' => textValue($link['title'] ?? '', 40, 1), 'url' => $url];
                }, $value);
                break;
            case 'category':
                if (!in_array($value, COMMUNITY_CATEGORIES, true)) throw new ApiError('invalid_settings');
                $settings[$key] = $value;
                break;
            case 'language':
                if (!in_array($value, COMMUNITY_LANGUAGES, true)) throw new ApiError('invalid_settings');
                $settings[$key] = $value;
                break;
            case 'show_subscriber_count': case 'show_author': case 'reactions_enabled': case 'comments_enabled': case 'members_can_invite':
                if (!is_bool($value)) throw new ApiError('invalid_settings');
                $settings[$key] = $value;
                break;
            case 'allowed_reactions':
                if (!is_array($value) || !array_is_list($value) || count($value) > 12) throw new ApiError('invalid_settings');
                $settings[$key] = array_values(array_unique(array_map('reactionValue', $value)));
                break;
            default:
                throw new ApiError('invalid_settings');
        }
    }
    if ($type !== 'channel') $settings['comments_enabled'] = false;
    return $settings;
}

function communityCard(array $row, int $userId): array
{
    $settings = array_replace(communityDefaults(), json_decode($row['settings'] ?? '{}', true) ?: []);
    return [
        'id' => (int)$row['id'], 'type' => $row['type'], 'name' => $row['name'], 'description' => $row['description'], 'slug' => $row['slug'],
        'avatar_url' => $row['avatar_file_id'] ? 'media.php?id=' . $row['avatar_file_id'] : null,
        'member_count' => $settings['show_subscriber_count'] ? (int)$row['member_count'] : null, 'joined' => (bool)$row['joined'],
        'tagline' => $settings['tagline'], 'category' => $settings['category'], 'accent' => $settings['accent'],
    ];
}

function communitySearch(string $q, int $userId, array $types, int $limit = 30): array
{
    $search = '%' . likeEscape($q) . '%';
    $typeSql = placeholders($types);
    $rows = query("SELECT c.id,c.type,c.name,c.description,c.slug,c.avatar_file_id,c.settings,(SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id=c.id) AS member_count,EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=?) AS joined FROM conversations c WHERE c.type IN ($typeSql) AND c.visibility='public' AND c.archived_at IS NULL AND (c.name ILIKE ? OR c.slug ILIKE ? OR c.description ILIKE ?) AND NOT EXISTS(SELECT 1 FROM conversation_bans b WHERE b.conversation_id=c.id AND b.user_id=?) ORDER BY (lower(c.slug)=lower(?)) DESC,(c.name ILIKE ?) DESC,c.updated_at DESC LIMIT " . max(1, min(50, $limit)), array_merge([$userId], $types, [$search, $search, $search, $userId, ltrim($q, '@'), likeEscape($q) . '%']))->fetchAll();
    return array_map(fn($row) => communityCard($row, $userId), $rows);
}

function communityJoin(array $input, int $userId): int
{
    return transaction(function () use ($input, $userId): int {
        $invite = null;
        if (!empty($input['invite_token'])) {
            $token = textValue($input['invite_token'], 64, 16);
            if (!preg_match('/^[A-Za-z0-9_-]+$/D', $token)) throw new ApiError('channel_not_found', 404);
            $invite = query('SELECT * FROM conversation_invites WHERE token=? FOR UPDATE', [$token])->fetch() ?: null;
            if ($invite) {
                if ($invite['revoked_at'] !== null || ($invite['expires_at'] !== null && (int)$invite['expires_at'] <= time()) || ($invite['max_uses'] !== null && (int)$invite['uses'] >= (int)$invite['max_uses'])) throw new ApiError('invite_expired', 410);
                $channel = query("SELECT * FROM conversations WHERE id=? AND type IN ('channel','group') FOR UPDATE", [$invite['conversation_id']])->fetch();
            } else {
                $channel = query("SELECT * FROM conversations WHERE type IN ('channel','group') AND invite_token=? FOR UPDATE", [$token])->fetch();
            }
        } else {
            $slug = channelSlug($input['slug'] ?? null);
            if (!$slug && !empty($input['conversation_id'])) {
                $channel = query("SELECT * FROM conversations WHERE id=? AND type IN ('channel','group') AND visibility='public' FOR UPDATE", [intValue($input['conversation_id'])])->fetch();
            } else {
                if (!$slug) throw new ApiError('invalid_channel_slug');
                $channel = query("SELECT * FROM conversations WHERE type IN ('channel','group') AND visibility='public' AND slug=? FOR UPDATE", [$slug])->fetch();
            }
        }
        if (!$channel || $channel['archived_at'] !== null) throw new ApiError('channel_not_found', 404);
        if (query('SELECT 1 FROM conversation_bans WHERE conversation_id=? AND user_id=?', [$channel['id'], $userId])->fetchColumn()) throw new ApiError('community_banned', 403);
        $inserted = query('INSERT INTO conversation_members(conversation_id,user_id,last_read_message_id,last_delivered_message_id,joined_at) VALUES(?,?,COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=?),0),COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=?),0),?) ON CONFLICT DO NOTHING RETURNING user_id', [$channel['id'], $userId, $channel['id'], $channel['id'], time()])->fetchColumn();
        if ($inserted) {
            if ($invite) query('UPDATE conversation_invites SET uses=uses+1 WHERE id=?', [$invite['id']]);
            statsBump((int)$channel['id'], 'joins');
        }
        return (int)$channel['id'];
    });
}

function addCommunityMembers(array $conversation, array $ids, array $actor): void
{
    $actorId = (int)$actor['id'];
    foreach (array_unique($ids) as $value) {
        $member = intValue($value);
        if ($member === $actorId) continue;
        if (!query('SELECT id FROM users WHERE id=?', [$member])->fetchColumn()) throw new ApiError('invalid_members');
        if (blockedEither($actorId, $member) || !privacyAllows($member, $actorId, 'group_invites')) throw new ApiError('privacy_restricted', 403);
        if (query('SELECT 1 FROM conversation_bans WHERE conversation_id=? AND user_id=?', [$conversation['id'], $member])->fetchColumn()) throw new ApiError('community_banned', 403);
        $added = query('INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING user_id', [$conversation['id'], $member, time()])->fetchColumn();
        if ($added) {
            statsBump((int)$conversation['id'], 'joins');
            communityAudit((int)$conversation['id'], $actorId, 'member.add', $member);
        }
    }
}

function requirePassword(array $user, mixed $password): void
{
    rateLimit('password_confirm', 10, 900, (string)$user['id']);
    if (!is_string($password) || !password_verify($password, $user['password_hash'])) throw new ApiError('current_password_invalid', 403);
}

function channelsHandle(string $action,array $input,array $user): array {
    $uid=(int)$user['id'];
    rateLimit('channels',120,60,(string)$uid);
    if($action==='channels.search'){
        $q=textValue($input['q']??'',80);
        $types=($input['type']??'channel')==='all'?['channel','group']:[($input['type']??'channel')==='group'?'group':'channel'];
        return ['channels'=>communitySearch($q,$uid,$types,50)];
    }
    if($action==='channels.join'){
        $id=communityJoin($input,$uid);
        return normalizedConversation(conversationFor($id,$uid),$uid);
    }
    $id=intValue($input['conversation_id']??null);
    $channel=conversationFor($id,$uid);
    if(!in_array($channel['type'],['channel','group'],true))throw new ApiError('channel_not_found',404);
    $can=fn(string $permission):bool=>memberCan($channel,$user,$permission);
    $isOwner=(int)$channel['owner_id']===$uid;
    switch($action){
        case 'channels.leave':
            if($isOwner)throw new ApiError('channel_owner_cannot_leave',403);
            transaction(function()use($id,$uid):void{
                if(query('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=? RETURNING user_id',[$id,$uid])->fetchColumn())statsBump($id,'leaves');
            });
            return ['left'=>true,'conversation_id'=>$id];
        case 'channels.own_theme':
            query('UPDATE conversation_members SET own_theme=? WHERE conversation_id=? AND user_id=?',[!empty($input['enabled'])?1:0,$id,$uid]);
            break;
        case 'channels.update':
            if(array_intersect(array_keys($input),['name','description','slug','visibility','avatar_file_id','cover_file_id','settings','discussion_id'])&&!$can('change_info'))throw new ApiError('channel_owner_only',403);
            if(!empty($input['rotate_invite'])&&!$can('invite'))throw new ApiError('channel_owner_only',403);
            if(!empty($input['add_user_ids'])&&!$can('manage_members')&&!$can('invite'))throw new ApiError('channel_owner_only',403);
            if(!empty($input['remove_user_ids'])&&!$can('manage_members'))throw new ApiError('channel_owner_only',403);
            transaction(function()use($id,$uid,$input,$user):void{
                $channel=query('SELECT * FROM conversations WHERE id=? FOR UPDATE',[$id])->fetch();
                $updates=[];$values=[];$changed=[];
                foreach(['name'=>80,'description'=>500] as $key=>$max)if(array_key_exists($key,$input)){$updates[]=$key.'=?';$values[]=textValue($input[$key],$max,$key==='name'?1:0);$changed[]=$key;}
                $slug=array_key_exists('slug',$input)?channelSlug($input['slug']):$channel['slug'];
                $visibility=$input['visibility']??$channel['visibility'];
                if(!in_array($visibility,['public','private'],true)||$visibility==='public'&&!$slug)throw new ApiError('invalid_channel_slug');
                if(array_key_exists('slug',$input)){$updates[]='slug=?';$values[]=$slug;$changed[]='slug';}
                if(array_key_exists('visibility',$input)){$updates[]='visibility=?';$values[]=$visibility;$changed[]='visibility';}
                if(!empty($input['rotate_invite'])){$updates[]='invite_token=?';$values[]=bin2hex(random_bytes(24));$changed[]='invite';}
                foreach(['avatar_file_id','cover_file_id'] as $key)if(array_key_exists($key,$input)){
                    $file=$input[$key]?intValue($input[$key]):null;
                    if($file&&!query("SELECT id FROM files WHERE id=? AND owner_id=? AND mime IN ('image/png','image/jpeg','image/webp','image/gif','image/avif')",[$file,$uid])->fetchColumn())throw new ApiError('invalid_avatar');
                    $updates[]=$key.'=?';$values[]=$file;$changed[]=$key;
                }
                if(array_key_exists('settings',$input)){
                    if(!is_array($input['settings']))throw new ApiError('invalid_settings');
                    $updates[]='settings=?';$values[]=json_encode(communitySettingsInput($input['settings'],communitySettings($channel),$channel['type']),JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE);$changed[]='appearance';
                }
                if(array_key_exists('discussion_id',$input)){
                    $discussion=$input['discussion_id']?intValue($input['discussion_id']):null;
                    if($discussion&&($channel['type']!=='channel'||!query("SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND c.type='group' AND m.user_id=? AND m.role IN ('owner','admin')",[$discussion,$uid])->fetchColumn()))throw new ApiError('invalid_discussion');
                    $updates[]='discussion_id=?';$values[]=$discussion;$changed[]='discussion';
                }
                if($updates){$updates[]='updated_at=?';$values[]=time();$values[]=$id;try{query('UPDATE conversations SET '.implode(',',$updates).' WHERE id=?',$values);}catch(PDOException $error){if($error->getCode()==='23505')throw new ApiError('channel_slug_taken',409);throw $error;}
                    communityAudit($id,$uid,'info.update',null,['fields'=>$changed]);}
                $add=$input['add_user_ids']??[];$remove=$input['remove_user_ids']??[];
                foreach([$add,$remove] as $list)if(!is_array($list)||!array_is_list($list)||count($list)>100)throw new ApiError('invalid_members');
                if($add)addCommunityMembers($channel,$add,$user);
                foreach(array_unique($remove) as $value){
                    $member=intValue($value);
                    if($member===$uid||$member===(int)$channel['owner_id'])continue;
                    if(query('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=? RETURNING user_id',[$id,$member])->fetchColumn()){statsBump($id,'leaves');communityAudit($id,$uid,'member.remove',$member);}
                }
            });
            break;
        case 'channels.members':
            if(!$can('manage_members')&&$channel['type']==='channel')throw new ApiError('channel_owner_only',403);
            $q=textValue($input['q']??'',80);$offset=intValue($input['offset']??0,0);
            $rows=query("SELECT u.*,cm.role AS member_role,cm.permissions AS member_permissions,cm.joined_at FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? AND (?='' OR u.name ILIKE ? OR u.username ILIKE ?) ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.name,u.id LIMIT 51 OFFSET ".min($offset,100000),[$id,$q,'%'.likeEscape($q).'%','%'.likeEscape($q).'%'])->fetchAll();
            privacyPrefetch(array_column($rows,'id'),$uid);premiumPrefetch(array_column($rows,'id'));
            $more=count($rows)>50;$rows=array_slice($rows,0,50);
            return ['members'=>array_map(fn($row)=>['user'=>normalizedUser($row),'role'=>$row['member_role'],'permissions'=>json_decode($row['member_permissions'],true)?:new stdClass(),'joined_at'=>(int)$row['joined_at']],$rows),'has_more'=>$more,'total'=>(int)query('SELECT COUNT(*) FROM conversation_members WHERE conversation_id=?',[$id])->fetchColumn()];
        case 'channels.set_role':
            if(!$isOwner)throw new ApiError('channel_owner_only',403);
            $target=intValue($input['user_id']??null);$role=$input['role']??'';
            if(!in_array($role,['admin','member'],true)||$target===$uid)throw new ApiError('invalid_role');
            $permissions=[];
            if($role==='admin'){
                $requested=$input['permissions']??[];
                if(!is_array($requested))throw new ApiError('invalid_role');
                foreach(COMMUNITY_PERMISSIONS as $key)if(array_key_exists($key,$requested)){if(!is_bool($requested[$key]))throw new ApiError('invalid_role');$permissions[$key]=$requested[$key];}
            }
            $updated=query('UPDATE conversation_members SET role=?,permissions=? WHERE conversation_id=? AND user_id=? RETURNING user_id',[$role,json_encode((object)$permissions),$id,$target])->fetchColumn();
            if(!$updated)throw new ApiError('member_not_found',404);
            communityAudit($id,$uid,'role.'.$role,$target,['permissions'=>$permissions]);
            break;
        case 'channels.ban':
            if(!$can('ban'))throw new ApiError('channel_owner_only',403);
            $target=intValue($input['user_id']??null);
            if($target===$uid||$target===(int)$channel['owner_id'])throw new ApiError('invalid_ban');
            $targetRole=query('SELECT role FROM conversation_members WHERE conversation_id=? AND user_id=?',[$id,$target])->fetchColumn();
            if($targetRole==='admin'&&!$isOwner)throw new ApiError('channel_owner_only',403);
            transaction(function()use($id,$uid,$target,$input):void{
                query('INSERT INTO conversation_bans(conversation_id,user_id,banned_by,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET reason=excluded.reason',[$id,$target,$uid,textValue($input['reason']??'',200),time()]);
                if(query('DELETE FROM conversation_members WHERE conversation_id=? AND user_id=? RETURNING user_id',[$id,$target])->fetchColumn())statsBump($id,'leaves');
                if(!empty($input['delete_messages']))query("UPDATE messages SET deleted=1,text='',file_id=NULL,pinned=0,updated_at=? WHERE conversation_id=? AND sender_id=? AND deleted=0",[time(),$id,$target]);
                communityAudit($id,$uid,'member.ban',$target,['delete_messages'=>!empty($input['delete_messages'])]);
            });
            break;
        case 'channels.unban':
            if(!$can('ban'))throw new ApiError('channel_owner_only',403);
            $target=intValue($input['user_id']??null);
            query('DELETE FROM conversation_bans WHERE conversation_id=? AND user_id=?',[$id,$target]);
            communityAudit($id,$uid,'member.unban',$target);
            break;
        case 'channels.bans':
            if(!$can('ban'))throw new ApiError('channel_owner_only',403);
            $rows=query('SELECT u.*,b.reason,b.created_at AS banned_at FROM conversation_bans b JOIN users u ON u.id=b.user_id WHERE b.conversation_id=? ORDER BY b.created_at DESC LIMIT 200',[$id])->fetchAll();
            privacyPrefetch(array_column($rows,'id'),$uid);
            return ['bans'=>array_map(fn($row)=>['user'=>normalizedUser($row),'reason'=>$row['reason'],'created_at'=>(int)$row['banned_at']],$rows)];
        case 'channels.invites':
            if(!$can('invite'))throw new ApiError('channel_owner_only',403);
            return ['primary'=>$channel['invite_token'],'invites'=>array_map(fn($row)=>['id'=>(int)$row['id'],'token'=>$row['token'],'name'=>$row['name'],'max_uses'=>$row['max_uses']!==null?(int)$row['max_uses']:null,'uses'=>(int)$row['uses'],'expires_at'=>$row['expires_at']!==null?(int)$row['expires_at']:null,'revoked'=>$row['revoked_at']!==null,'expired'=>$row['expires_at']!==null&&(int)$row['expires_at']<=time()||$row['max_uses']!==null&&(int)$row['uses']>=(int)$row['max_uses'],'created_at'=>(int)$row['created_at']],query('SELECT * FROM conversation_invites WHERE conversation_id=? ORDER BY id DESC LIMIT 100',[$id])->fetchAll())];
        case 'channels.invite_create':
            if(!$can('invite'))throw new ApiError('channel_owner_only',403);
            $maxUses=isset($input['max_uses'])&&$input['max_uses']!==null?intValue($input['max_uses']):null;
            if($maxUses!==null&&$maxUses>100000)throw new ApiError('invalid_invite');
            $expires=isset($input['expires_in'])&&$input['expires_in']!==null?intValue($input['expires_in'],3600):null;
            if($expires!==null&&$expires>366*86400)throw new ApiError('invalid_invite');
            if((int)query('SELECT COUNT(*) FROM conversation_invites WHERE conversation_id=? AND revoked_at IS NULL',[$id])->fetchColumn()>=50)throw new ApiError('invite_limit',429);
            $inviteId=insertId('INSERT INTO conversation_invites(conversation_id,token,created_by,name,max_uses,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',[$id,rtrim(strtr(base64_encode(random_bytes(18)),'+/','-_'),'='),$uid,textValue($input['name']??'',60),$maxUses,$expires!==null?time()+$expires:null,time()]);
            communityAudit($id,$uid,'invite.create',null,['invite_id'=>$inviteId,'max_uses'=>$maxUses,'expires_in'=>$expires]);
            return channelsHandle('channels.invites',['conversation_id'=>$id],$user);
        case 'channels.invite_revoke':
            if(!$can('invite'))throw new ApiError('channel_owner_only',403);
            $inviteId=intValue($input['invite_id']??null);
            query('UPDATE conversation_invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND conversation_id=?',[time(),$inviteId,$id]);
            communityAudit($id,$uid,'invite.revoke',null,['invite_id'=>$inviteId]);
            return channelsHandle('channels.invites',['conversation_id'=>$id],$user);
        case 'channels.audit':
            if(!$isOwner&&$channel['member_role']!=='admin'&&$user['role']!=='admin')throw new ApiError('channel_owner_only',403);
            $rows=query('SELECT a.*,u.name AS actor_name,t.name AS target_name FROM conversation_audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users t ON t.id=a.target_user_id WHERE a.conversation_id=? ORDER BY a.id DESC LIMIT 200',[$id])->fetchAll();
            return ['entries'=>array_map(fn($row)=>['id'=>(int)$row['id'],'action'=>$row['action'],'actor_name'=>$row['actor_name'],'target_name'=>$row['target_name'],'details'=>json_decode($row['details'],true),'created_at'=>(int)$row['created_at']],$rows)];
        case 'channels.transfer':
            if(!$isOwner)throw new ApiError('channel_owner_only',403);
            requirePassword($user,$input['password']??null);
            $target=intValue($input['user_id']??null);
            transaction(function()use($id,$uid,$target):void{
                lockKey('chat:'.$id);
                if($target===$uid||!query('SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?',[$id,$target])->fetchColumn())throw new ApiError('member_not_found',404);
                query('UPDATE conversations SET owner_id=?,updated_at=? WHERE id=?',[$target,time(),$id]);
                query("UPDATE conversation_members SET role='owner',permissions='{}' WHERE conversation_id=? AND user_id=?",[$id,$target]);
                query("UPDATE conversation_members SET role='admin',permissions='{}' WHERE conversation_id=? AND user_id=?",[$id,$uid]);
                communityAudit($id,$uid,'owner.transfer',$target);
            });
            break;
        case 'channels.archive':
            if(!$isOwner)throw new ApiError('channel_owner_only',403);
            $archive=!empty($input['archived']);
            query('UPDATE conversations SET archived_at=?,updated_at=? WHERE id=?',[$archive?time():null,time(),$id]);
            communityAudit($id,$uid,$archive?'community.archive':'community.unarchive');
            break;
        case 'channels.delete':
            if(!$isOwner)throw new ApiError('channel_owner_only',403);
            requirePassword($user,$input['password']??null);
            if(!is_string($input['confirm_name']??null)||trim($input['confirm_name'])!==$channel['name'])throw new ApiError('confirm_name_mismatch');
            query('DELETE FROM conversations WHERE id=?',[$id]);
            return ['deleted'=>true,'conversation_id'=>$id];
        case 'channels.stats':
            if(!$can('view_stats'))throw new ApiError('channel_owner_only',403);
            return communityStats($id,in_array((int)($input['days']??7),[7,30],true)?(int)$input['days']:7);
        default:
            throw new ApiError('invalid_action',404);
    }
    return normalizedConversation(conversationFor($id,$uid),$uid);
}

/** Real aggregated counters only. Days without data are zero, never invented. */
function communityStats(int $id, int $days): array
{
    $from = time() - ($days - 1) * 86400;
    $series = [];
    for ($i = $days - 1; $i >= 0; $i--) {
        $day = gmdate('Y-m-d', time() - $i * 86400);
        $series[$day] = ['day' => $day, 'joins' => 0, 'leaves' => 0, 'views' => 0, 'reactions' => 0, 'comments' => 0, 'posts' => 0];
    }
    foreach (query("SELECT to_char(day,'YYYY-MM-DD') AS day,joins,leaves,views FROM channel_stats_daily WHERE conversation_id=? AND day>=CURRENT_DATE-?::int", [$id, $days - 1])->fetchAll() as $row) {
        if (isset($series[$row['day']])) $series[$row['day']] = array_replace($series[$row['day']], ['joins' => (int)$row['joins'], 'leaves' => (int)$row['leaves'], 'views' => (int)$row['views']]);
    }
    $dayOf = "to_char(to_timestamp(%s) AT TIME ZONE 'UTC','YYYY-MM-DD')";
    foreach (query('SELECT ' . sprintf($dayOf, 'r.created_at') . ' AS day,COUNT(*) AS count FROM reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=? AND r.created_at>=? GROUP BY 1', [$id, $from - 86400])->fetchAll() as $row) {
        if (isset($series[$row['day']])) $series[$row['day']]['reactions'] = (int)$row['count'];
    }
    foreach (query('SELECT ' . sprintf($dayOf, 'created_at') . " AS day,COUNT(*) FILTER (WHERE thread_root_id IS NOT NULL) AS comments,COUNT(*) FILTER (WHERE thread_root_id IS NULL AND kind<>'call') AS posts FROM messages WHERE conversation_id=? AND deleted=0 AND created_at>=? GROUP BY 1", [$id, $from - 86400])->fetchAll() as $row) {
        if (isset($series[$row['day']])) { $series[$row['day']]['comments'] = (int)$row['comments']; $series[$row['day']]['posts'] = (int)$row['posts']; }
    }
    $top = query('SELECT m.*,COALESCE(v.views,0) AS view_count,(SELECT COUNT(*) FROM reactions r WHERE r.message_id=m.id) AS reaction_count,(SELECT COUNT(*) FROM messages c WHERE c.thread_root_id=m.id AND c.deleted=0) AS comment_count FROM messages m LEFT JOIN message_views v ON v.message_id=m.id WHERE m.conversation_id=? AND m.thread_root_id IS NULL AND m.deleted=0 AND m.created_at>=? ORDER BY COALESCE(v.views,0)+3*(SELECT COUNT(*) FROM reactions r WHERE r.message_id=m.id) DESC,m.id DESC LIMIT 5', [$id, $from])->fetchAll();
    $subscribers = (int)query('SELECT COUNT(*) FROM conversation_members WHERE conversation_id=?', [$id])->fetchColumn();
    $series = array_values($series);
    return [
        'days' => $days, 'subscribers' => $subscribers,
        'growth' => array_sum(array_column($series, 'joins')) - array_sum(array_column($series, 'leaves')),
        'totals' => ['views' => array_sum(array_column($series, 'views')), 'reactions' => array_sum(array_column($series, 'reactions')), 'comments' => array_sum(array_column($series, 'comments')), 'joins' => array_sum(array_column($series, 'joins')), 'leaves' => array_sum(array_column($series, 'leaves'))],
        'series' => $series,
        'top_posts' => array_map(fn($row) => ['id' => (int)$row['id'], 'text' => mb_substr($row['text'], 0, 140), 'kind' => $row['kind'], 'views' => (int)$row['view_count'], 'reactions' => (int)$row['reaction_count'], 'comments' => (int)$row['comment_count'], 'created_at' => (int)$row['created_at']], $top),
        'tracking_since' => (int)(query('SELECT EXTRACT(EPOCH FROM MIN(day))::bigint FROM channel_stats_daily WHERE conversation_id=?', [$id])->fetchColumn() ?: 0),
    ];
}
