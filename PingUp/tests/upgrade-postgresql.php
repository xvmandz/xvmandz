<?php
declare(strict_types=1);
// Upgrades a populated PingUp 2.0 (schema 4) database to the current schema and checks that data survives.
// Requires an EMPTY disposable database named pingup_test_* (PINGUP_DATABASE_* env). Never use production.
$root = dirname(__DIR__);
require $root . '/src/bootstrap.php';
function check(bool $ok, string $label): void { if (!$ok) throw new RuntimeException('FAIL: ' . $label); }
check(str_starts_with((string)query('SELECT current_database()')->fetchColumn(), 'pingup_test_'), 'disposable database');
check(!query("SELECT to_regclass('public.users')")->fetchColumn(), 'empty database');

// 1. Schema 4 exactly as PingUp 2.0 installed it, with representative data.
db()->exec(file_get_contents($root . '/database/postgresql.sql'));
check((int)query('SELECT MAX(version) FROM schema_migrations')->fetchColumn() === 4, 'baseline schema 4');
query("INSERT INTO users(id,username,name,password_hash,role,last_seen,created_at) VALUES(1,'owner','Owner','x','user',1,1),(2,'reader','Reader','x','user',1,1),(3,'boss','Boss','x','admin',1,1)");
query("INSERT INTO conversations(id,type,name,owner_id,created_at,updated_at,visibility,slug,invite_token) VALUES(10,'channel','News',1,1,1,'public','news_old','tok'),(11,'group','Team',2,1,1,'private',NULL,NULL)");
query('INSERT INTO conversation_members(conversation_id,user_id,last_read_message_id) VALUES(10,1,0),(10,2,5),(11,1,0),(11,2,0)');
query("INSERT INTO messages(id,conversation_id,sender_id,text,client_id,pinned,created_at,updated_at) VALUES(5,10,1,'Old post','c5',1,100,150),(6,11,2,'Hi team','c6',0,120,120)");
query("INSERT INTO reactions(message_id,user_id,emoji) VALUES(5,2,'🔥')");
query("SELECT setval(pg_get_serial_sequence('users','id'),3)");
query("SELECT setval(pg_get_serial_sequence('messages','id'),6)");

// 2. Upgrade with the real CLI, twice (the second run must be a no-op).
foreach ([1, 2] as $run) {
    exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($root . '/bin/migrate.php') . ' 2>&1', $output, $code);
    check($code === 0, 'migrate run ' . $run . ': ' . implode(' ', $output));
}
check((int)query('SELECT MAX(version) FROM schema_migrations')->fetchColumn() === PINGUP_SCHEMA_VERSION, 'current schema');
check((int)query('SELECT COUNT(*) FROM schema_migrations')->fetchColumn() === PINGUP_SCHEMA_VERSION - 3, 'each migration recorded once');

// 3. Existing data is intact and derived 2.1 columns are filled.
check(query("SELECT text FROM messages WHERE id=5")->fetchColumn() === 'Old post', 'messages kept');
check((int)query('SELECT COUNT(*) FROM reactions')->fetchColumn() === 1, 'reactions kept');
check(query('SELECT role FROM conversation_members WHERE conversation_id=10 AND user_id=1')->fetchColumn() === 'owner', 'channel owner role');
check(query('SELECT role FROM conversation_members WHERE conversation_id=11 AND user_id=2')->fetchColumn() === 'owner', 'group owner role');
check(query('SELECT role FROM conversation_members WHERE conversation_id=10 AND user_id=2')->fetchColumn() === 'member', 'reader role');
check((int)query('SELECT last_delivered_message_id FROM conversation_members WHERE conversation_id=10 AND user_id=2')->fetchColumn() === 5, 'delivery cursor seeded from read cursor');
check((int)query('SELECT pinned_at FROM messages WHERE id=5')->fetchColumn() === 150, 'pin time backfilled');
check(query("SELECT settings::text FROM conversations WHERE id=10")->fetchColumn() === '{}', 'default community settings');
check((int)query('SELECT COUNT(*) FROM stickers')->fetchColumn() === 12, 'built-in sticker pack');

// 4. The upgraded database works through the application layer.
PrivacyCache::$viewer = 2;
$reader = query('SELECT * FROM users WHERE id=2')->fetch();
$list = conversationsList(2);
check(count($list) === 2, 'chat list after upgrade');
$channel = array_values(array_filter($list, fn($c) => $c['id'] === 10))[0];
check($channel['permissions']['post'] === false && $channel['role'] === 'member', 'reader cannot post');
$message = sendMessage(['conversation_id' => 11, 'text' => 'After upgrade', 'client_id' => 'upgrade-check-1'], $reader);
check($message['id'] > 6, 'identity continues after existing rows');
echo "PASS: schema 4 → " . PINGUP_SCHEMA_VERSION . " upgrade on populated data (idempotent rerun), owners/cursors/pins derived, app layer works.\n";
