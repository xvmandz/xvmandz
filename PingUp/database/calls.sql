-- Signaling metadata only. Media travels between browsers over encrypted WebRTC.
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('audio','video')),
    status TEXT NOT NULL DEFAULT 'ringing' CHECK(status IN ('ringing','active','ended','rejected')),
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT,
    caller_heartbeat INTEGER NOT NULL,
    callee_heartbeat INTEGER NOT NULL,
    CHECK(caller_id <> callee_id)
);
CREATE INDEX IF NOT EXISTS calls_caller ON calls(caller_id,status,id);
CREATE INDEX IF NOT EXISTS calls_callee ON calls(callee_id,status,id);
CREATE TABLE IF NOT EXISTS call_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('offer','answer','candidate')),
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_signals_call ON call_signals(call_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS call_sdp_once ON call_signals(call_id,sender_id,type) WHERE type IN ('offer','answer');
