PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 1,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
    bio TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    accent TEXT NOT NULL DEFAULT '#a78bfa',
    avatar_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    locale TEXT NOT NULL DEFAULT 'ru' CHECK(locale IN ('ru','uk','en')),
    theme TEXT NOT NULL DEFAULT 'dark' CHECK(theme IN ('dark','light','system')),
    last_seen INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('direct','group','channel','saved')),
    name TEXT NOT NULL DEFAULT '',
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direct_key TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
    PRIMARY KEY (conversation_id,user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON conversation_members(user_id,conversation_id);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    disk_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','file','voice')),
    file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    forwarded_from INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    client_id TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
    edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(sender_id,client_id)
);
CREATE INDEX IF NOT EXISTS messages_conversation_id ON messages(conversation_id,id);
CREATE INDEX IF NOT EXISTS messages_conversation_updated ON messages(conversation_id,updated_at);
CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    PRIMARY KEY(message_id,user_id,emoji)
);
CREATE TABLE IF NOT EXISTS typing (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
PRAGMA user_version = 2;
