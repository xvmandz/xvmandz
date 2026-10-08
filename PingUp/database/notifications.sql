CREATE TABLE IF NOT EXISTS notification_settings (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 settings TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS notification_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('message','mention','call')),
 message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
 call_id INTEGER REFERENCES calls(id) ON DELETE CASCADE,
 dedup_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(user_id,dedup_key)
);
CREATE INDEX IF NOT EXISTS notification_events_user ON notification_events(user_id,id);
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL,
 endpoint_hash TEXT NOT NULL UNIQUE,
 p256dh TEXT NOT NULL,
 auth TEXT NOT NULL,
 session_hash TEXT NOT NULL,
 session_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS push_deliveries (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id INTEGER NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
 subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','sent','cancelled','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0,
 error_code TEXT,
 UNIQUE(event_id,subscription_id)
);
CREATE INDEX IF NOT EXISTS push_deliveries_pending ON push_deliveries(status,available_at,lease_until);
