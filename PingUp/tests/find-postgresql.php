<?php
declare(strict_types=1);
// In-chat search on a long history (messages.find). Requires an EMPTY migrated pingup_test_* database.
require dirname(__DIR__).'/src/bootstrap.php';
require dirname(__DIR__).'/src/actions.php';
function check(bool $ok, string $label): void { if (!$ok) throw new RuntimeException('FAIL: '.$label); }
check(str_starts_with((string)query('SELECT current_database()')->fetchColumn(), 'pingup_test_'), 'disposable database');
check((int)query('SELECT COUNT(*) FROM users')->fetchColumn() === 0, 'empty database');

// 20 000 messages; every 7th mentions "needle". Some matches are deleted, hidden for the viewer, or comments.
transaction(function (): void {
    query("INSERT INTO users(id,username,name,password_hash,last_seen,created_at) VALUES(1,'viewer','Viewer','x',1,1),(2,'peer','Peer','x',1,1),(3,'outsider','Out','x',1,1)");
    query("SELECT setval(pg_get_serial_sequence('users','id'),3)");
    query("INSERT INTO conversations(id,type,owner_id,created_at,updated_at) VALUES(1,'direct',1,1,1)");
    query('INSERT INTO conversation_members(conversation_id,user_id) VALUES(1,1),(1,2)');
    query("INSERT INTO messages(conversation_id,sender_id,text,client_id,created_at,updated_at) SELECT 1,1+(n%2),CASE WHEN n%7=0 THEN 'Here is the Needle #'||n ELSE 'Plain message '||n END,'find:'||n,n,n FROM generate_series(1,20000) n");
});
db()->exec('ANALYZE');
$matches = intdiv(20000, 7); // 2857
$ids = array_map('intval', query("SELECT id FROM messages WHERE text LIKE '%Needle%' ORDER BY id DESC")->fetchAll(PDO::FETCH_COLUMN));
query('UPDATE messages SET deleted=1 WHERE id=?', [$ids[0]]);
query('INSERT INTO message_hidden(message_id,user_id,created_at) VALUES(?,1,1)', [$ids[1]]);
$visibleMatches = $matches - 2;

$started = hrtime(true);
$first = conversationFind(['conversation_id' => 1, 'q' => 'needle', 'limit' => 40], 1);
$ms = (hrtime(true) - $started) / 1e6;
check($first['total_messages'] === 20000 - 2, 'total visible messages: '.$first['total_messages']);
check($first['total_matches'] === $visibleMatches && !$first['capped'], 'match count (case-insensitive, deleted/hidden excluded): '.$first['total_matches']);
check(count($first['messages']) === 40 && $first['has_more'], 'first page');
check($first['messages'][0]['id'] === $ids[2], 'newest visible match first');

// Walk every page with the keyset cursor: no gaps, no duplicates, newest → oldest.
$seen = array_column($first['messages'], 'id');
$page = $first;
while ($page['has_more']) {
    $page = conversationFind(['conversation_id' => 1, 'q' => 'needle', 'limit' => 50, 'before_id' => end($seen)], 1);
    check(!isset($page['total_matches']), 'count is computed only on the first page');
    foreach ($page['messages'] as $m) $seen[] = $m['id'];
}
check(count($seen) === $visibleMatches && count(array_unique($seen)) === $visibleMatches, 'all matches paged exactly once');
$sorted = $seen; rsort($sorted);
check($seen === $sorted, 'descending order');

// LIKE wildcards are literal, empty query returns only the total, outsiders get nothing.
check(conversationFind(['conversation_id' => 1, 'q' => '%', 'limit' => 5], 1)['total_matches'] === 0, 'percent is literal');
$empty = conversationFind(['conversation_id' => 1, 'q' => '', 'limit' => 5], 1);
check($empty['total_matches'] === 0 && $empty['total_messages'] === 20000 - 2, 'empty query');
try { conversationFind(['conversation_id' => 1, 'q' => 'needle'], 3); check(false, 'outsider rejected'); }
catch (ApiError $error) { check($error->status === 404, 'outsider gets not found'); }

echo json_encode(['fixture' => ['messages' => 20000, 'matches' => $visibleMatches], 'first_page_ms' => round($ms, 2)]).PHP_EOL;
echo "PASS: in-chat search on 20 000 messages: exact counts, deleted/hidden excluded, keyset paging without gaps, literal wildcards, access control.\n";
