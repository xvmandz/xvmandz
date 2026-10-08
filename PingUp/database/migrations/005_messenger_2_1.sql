-- PingUp 2.1: contacts, privacy, receipts, premium, feedback, e-mail, channels, chat features.
-- Applied by bin/migrate.php inside one transaction after schema 4. Additive only: no user data removed.

-- Users: e-mail binding.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at BIGINT;
ALTER TABLE users ADD COLUMN profile_effect TEXT NOT NULL DEFAULT 'none';
CREATE UNIQUE INDEX users_email_unique ON users(lower(email)) WHERE email IS NOT NULL;

-- Privacy and per-user preferences (values: everyone/contacts/nobody, booleans).
CREATE TABLE privacy_settings (
 user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 settings JSONB NOT NULL DEFAULT '{}',
 updated_at BIGINT NOT NULL DEFAULT 0
);

-- Contacts: one row per unordered pair. Mutual contact = status accepted.
CREATE TABLE contacts (
 user_low BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 user_high BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 requested_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 PRIMARY KEY(user_low,user_high),
 CHECK(user_low<user_high)
);
CREATE INDEX contacts_high ON contacts(user_high,status);
CREATE INDEX contacts_low ON contacts(user_low,status);
CREATE TABLE user_blocks (
 blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at BIGINT NOT NULL,
 PRIMARY KEY(blocker_id,blocked_id),
 CHECK(blocker_id<>blocked_id)
);
CREATE INDEX user_blocks_blocked ON user_blocks(blocked_id);

-- Membership: delivery cursor, roles, archive, synced draft.
ALTER TABLE conversation_members ADD COLUMN last_delivered_message_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member'));
ALTER TABLE conversation_members ADD COLUMN permissions JSONB NOT NULL DEFAULT '{}';
ALTER TABLE conversation_members ADD COLUMN archived BIGINT NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
ALTER TABLE conversation_members ADD COLUMN own_theme BIGINT NOT NULL DEFAULT 0 CHECK(own_theme IN (0,1));
ALTER TABLE conversation_members ADD COLUMN joined_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE conversation_members ADD COLUMN draft TEXT NOT NULL DEFAULT '';
ALTER TABLE conversation_members ADD COLUMN draft_updated_at BIGINT NOT NULL DEFAULT 0;
UPDATE conversation_members SET last_delivered_message_id=last_read_message_id;
UPDATE conversation_members cm SET role='owner' FROM conversations c WHERE c.id=cm.conversation_id AND c.owner_id=cm.user_id AND c.type IN ('group','channel');

-- Conversations: appearance/settings, cover, discussion group, archive.
ALTER TABLE conversations ADD COLUMN settings JSONB NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN cover_file_id BIGINT REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN discussion_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN archived_at BIGINT;
CREATE INDEX groups_public_name_search ON conversations USING gin(name gin_trgm_ops) WHERE type='group' AND visibility='public';
CREATE INDEX conversations_public_desc_search ON conversations USING gin(description gin_trgm_ops) WHERE visibility='public' AND type IN ('channel','group');

-- Messages: comments (thread root), polls, stickers, albums, pin time.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK(kind IN ('text','file','voice','call','poll','sticker','album','system'));
ALTER TABLE messages ADD COLUMN thread_root_id BIGINT REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN poll_id BIGINT;
ALTER TABLE messages ADD COLUMN sticker_id BIGINT;
ALTER TABLE messages ADD COLUMN pinned_at BIGINT NOT NULL DEFAULT 0;
UPDATE messages SET pinned_at=updated_at WHERE pinned=1;
CREATE INDEX messages_thread ON messages(thread_root_id,id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX messages_pinned ON messages(conversation_id,pinned_at DESC) WHERE pinned=1 AND deleted=0;
CREATE TABLE message_files (
 message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 position INT NOT NULL CHECK(position BETWEEN 0 AND 9),
 PRIMARY KEY(message_id,position)
);
CREATE INDEX message_files_file ON message_files(file_id);
-- View counters live outside messages so increments do not advance the message change cursor.
CREATE TABLE message_views (
 message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 views BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE reactions ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0;
CREATE TABLE message_stars (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 created_at BIGINT NOT NULL,
 PRIMARY KEY(user_id,message_id)
);
CREATE TABLE polls (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 creator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 question TEXT NOT NULL,
 multiple BOOLEAN NOT NULL DEFAULT false,
 anonymous BOOLEAN NOT NULL DEFAULT true,
 closed_at BIGINT,
 created_at BIGINT NOT NULL
);
CREATE TABLE poll_options (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 poll_id BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 position INT NOT NULL,
 text TEXT NOT NULL,
 UNIQUE(poll_id,position)
);
CREATE TABLE poll_votes (
 poll_id BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
 option_id BIGINT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at BIGINT NOT NULL,
 PRIMARY KEY(poll_id,option_id,user_id)
);
CREATE INDEX poll_votes_user ON poll_votes(poll_id,user_id);
ALTER TABLE messages ADD CONSTRAINT messages_poll_fk FOREIGN KEY(poll_id) REFERENCES polls(id) ON DELETE SET NULL;

-- Scheduled messages and posts. Published by bin/cleanup.php (cron) and opportunistically by sync.
CREATE TABLE scheduled_messages (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 payload JSONB NOT NULL,
 send_at BIGINT NOT NULL,
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','sent','cancelled','failed')),
 message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
 error_code TEXT,
 created_at BIGINT NOT NULL
);
CREATE INDEX scheduled_due ON scheduled_messages(status,send_at);
CREATE INDEX scheduled_owner ON scheduled_messages(sender_id,conversation_id,status);

-- Chat folders.
CREATE TABLE chat_folders (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 position INT NOT NULL DEFAULT 0,
 types JSONB NOT NULL DEFAULT '[]',
 conversation_ids JSONB NOT NULL DEFAULT '[]',
 created_at BIGINT NOT NULL
);
CREATE INDEX chat_folders_user ON chat_folders(user_id,position);

-- Community management.
CREATE TABLE conversation_invites (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 token TEXT NOT NULL UNIQUE,
 created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 name TEXT NOT NULL DEFAULT '',
 max_uses BIGINT,
 uses BIGINT NOT NULL DEFAULT 0,
 expires_at BIGINT,
 revoked_at BIGINT,
 created_at BIGINT NOT NULL
);
CREATE INDEX conversation_invites_conv ON conversation_invites(conversation_id,id);
CREATE TABLE conversation_bans (
 conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 banned_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 reason TEXT NOT NULL DEFAULT '',
 created_at BIGINT NOT NULL,
 PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE conversation_audit (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 details JSONB NOT NULL DEFAULT '{}',
 created_at BIGINT NOT NULL
);
CREATE INDEX conversation_audit_conv ON conversation_audit(conversation_id,id DESC);
-- Aggregated counters only: no per-viewer rows are kept for analytics.
CREATE TABLE channel_stats_daily (
 conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 day DATE NOT NULL,
 joins BIGINT NOT NULL DEFAULT 0,
 leaves BIGINT NOT NULL DEFAULT 0,
 views BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(conversation_id,day)
);

-- Premium subscriptions: dated records, never a single flag.
CREATE TABLE subscriptions (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 plan TEXT NOT NULL DEFAULT 'premium' CHECK(plan IN ('premium')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 source TEXT NOT NULL CHECK(source IN ('admin','payment','promo')),
 starts_at BIGINT NOT NULL,
 ends_at BIGINT,
 granted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 revoked_at BIGINT,
 revoked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 note TEXT NOT NULL DEFAULT '',
 created_at BIGINT NOT NULL,
 CHECK(ends_at IS NULL OR ends_at>starts_at)
);
CREATE INDEX subscriptions_user ON subscriptions(user_id,status,ends_at);
CREATE TABLE admin_audit (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 target_type TEXT NOT NULL DEFAULT '',
 target_id BIGINT,
 details JSONB NOT NULL DEFAULT '{}',
 created_at BIGINT NOT NULL
);
CREATE INDEX admin_audit_target ON admin_audit(target_user_id,id DESC);

-- Feedback centre.
CREATE TABLE feedback_tickets (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type TEXT NOT NULL CHECK(type IN ('bug','idea','question')),
 category TEXT NOT NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','review','need_info','in_progress','fixed','closed','rejected')),
 priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
 tech_info JSONB,
 user_unread BOOLEAN NOT NULL DEFAULT false,
 staff_unread BOOLEAN NOT NULL DEFAULT true,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 closed_at BIGINT
);
CREATE INDEX feedback_user ON feedback_tickets(user_id,id DESC);
CREATE INDEX feedback_status ON feedback_tickets(status,updated_at DESC);
CREATE INDEX feedback_search ON feedback_tickets USING gin(title gin_trgm_ops);
CREATE TABLE feedback_messages (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 ticket_id BIGINT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
 author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 staff BOOLEAN NOT NULL DEFAULT false,
 internal BOOLEAN NOT NULL DEFAULT false,
 kind TEXT NOT NULL DEFAULT 'message' CHECK(kind IN ('message','status','priority')),
 body TEXT NOT NULL DEFAULT '',
 created_at BIGINT NOT NULL
);
CREATE INDEX feedback_messages_ticket ON feedback_messages(ticket_id,id);
CREATE TABLE feedback_files (
 ticket_id BIGINT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
 message_id BIGINT REFERENCES feedback_messages(id) ON DELETE CASCADE,
 file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 PRIMARY KEY(ticket_id,file_id)
);
CREATE INDEX feedback_files_file ON feedback_files(file_id);
ALTER TABLE files ADD COLUMN purpose TEXT NOT NULL DEFAULT 'file';

-- Notifications for feedback replies and contact requests.
ALTER TABLE notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_kind_check CHECK(kind IN ('message','mention','call','feedback','contact'));
ALTER TABLE notification_events ADD COLUMN feedback_ticket_id BIGINT REFERENCES feedback_tickets(id) ON DELETE CASCADE;
ALTER TABLE notification_events ADD COLUMN actor_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

-- E-mail verification and outbound queue.
CREATE TABLE email_tokens (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 email TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('verify','unlink','recovery')),
 code_hash TEXT NOT NULL,
 attempts INT NOT NULL DEFAULT 0,
 expires_at BIGINT NOT NULL,
 used_at BIGINT,
 created_at BIGINT NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens(user_id,purpose,id DESC);
CREATE TABLE email_outbox (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 to_email TEXT NOT NULL,
 subject TEXT NOT NULL,
 body_text TEXT NOT NULL,
 body_html TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed')),
 attempts INT NOT NULL DEFAULT 0,
 available_at BIGINT NOT NULL,
 lease_until BIGINT NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at BIGINT NOT NULL,
 sent_at BIGINT
);
CREATE INDEX email_outbox_pending ON email_outbox(status,available_at);

-- Stickers.
CREATE TABLE sticker_packs (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 system BOOLEAN NOT NULL DEFAULT false,
 created_at BIGINT NOT NULL
);
CREATE TABLE stickers (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 pack_id BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
 file_id BIGINT REFERENCES files(id) ON DELETE CASCADE,
 asset TEXT,
 emoji TEXT NOT NULL DEFAULT '',
 position INT NOT NULL DEFAULT 0,
 CHECK((file_id IS NULL) <> (asset IS NULL))
);
CREATE INDEX stickers_pack ON stickers(pack_id,position);
CREATE TABLE user_sticker_packs (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 pack_id BIGINT NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
 added_at BIGINT NOT NULL,
 PRIMARY KEY(user_id,pack_id)
);
ALTER TABLE messages ADD CONSTRAINT messages_sticker_fk FOREIGN KEY(sticker_id) REFERENCES stickers(id) ON DELETE SET NULL;
INSERT INTO sticker_packs(title,system,created_at) VALUES('PingUp',true,EXTRACT(EPOCH FROM now())::bigint);
INSERT INTO stickers(pack_id,asset,emoji,position)
 SELECT p.id,'assets/stickers/'||s.name||'.svg',s.emoji,s.position FROM sticker_packs p,
 (VALUES ('wave','👋',0),('love','💜',1),('laugh','😂',2),('cool','😎',3),('thanks','🙏',4),('party','🎉',5),('ping','📡',6),('sleep','😴',7),('wow','😮',8),('ok','👌',9),('sad','😢',10),('fire','🔥',11)) AS s(name,emoji,position)
 WHERE p.system;

-- Chunked uploads (large files without huge PHP request bodies).
CREATE TABLE upload_sessions (
 id TEXT PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 size BIGINT NOT NULL,
 received BIGINT NOT NULL DEFAULT 0,
 purpose TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 expires_at BIGINT NOT NULL
);
CREATE INDEX upload_sessions_expiry ON upload_sessions(expires_at);

-- Typing / recording indicator.
ALTER TABLE typing ADD COLUMN kind TEXT NOT NULL DEFAULT 'typing' CHECK(kind IN ('typing','recording','uploading'));
