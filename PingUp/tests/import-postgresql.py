#!/usr/bin/env python3
"""Round-trip a disposable schema-3 fixture into an EMPTY pingup_test_* PostgreSQL DB.
Set PINGUP_TEST_PHP and PINGUP_DATABASE_*; never pass a production database.
"""
import os,pathlib,tempfile,sqlite3,subprocess,json,hashlib,base64
root=pathlib.Path(__file__).resolve().parents[1]
php=os.environ.get('PINGUP_TEST_PHP','php')
assert 'dbname=pingup_test_' in os.environ.get('PINGUP_DATABASE_DSN',''),'Disposable database required'
with tempfile.TemporaryDirectory(prefix='pingup-import-') as temp:
 storage=pathlib.Path(temp);source=storage/'source.sqlite';conn=sqlite3.connect(source)
 conn.executescript((root/'database/schema.sql').read_text()+(root/'database/calls.sql').read_text())
 conn.executescript("ALTER TABLE conversation_members ADD COLUMN notification_mode TEXT NOT NULL DEFAULT 'all'; ALTER TABLE calls ADD COLUMN caller_device TEXT NOT NULL DEFAULT ''; ALTER TABLE calls ADD COLUMN callee_device TEXT NOT NULL DEFAULT ''; ALTER TABLE call_signals ADD COLUMN negotiation INTEGER NOT NULL DEFAULT 0; DROP INDEX call_sdp_once; CREATE UNIQUE INDEX call_sdp_once ON call_signals(call_id,sender_id,type,negotiation) WHERE type IN ('offer','answer');"+(root/'database/notifications.sql').read_text()+" PRAGMA user_version=3;")
 for i,(name,role) in enumerate([('alice','user'),('bob','user'),('admin','admin')],1):conn.execute('INSERT INTO users(id,username,name,password_hash,role,last_seen,created_at) VALUES(?,?,?,?,?,?,?)',(i,name,name.title(),'unchanged-hash-fixture',role,100,100))
 conn.execute("INSERT INTO files(id,owner_id,disk_name,original_name,mime,size,created_at) VALUES(7,1,'fixture.png','photo.png','image/png',5,100)")
 conn.execute('UPDATE users SET avatar_file_id=7 WHERE id=1')
 conn.execute("INSERT INTO conversations(id,type,name,owner_id,direct_key,created_at,updated_at) VALUES(5,'direct','',1,'direct:1:2',100,140)")
 conn.execute('INSERT INTO conversation_members(conversation_id,user_id,last_read_message_id,pinned,notification_mode) VALUES(5,1,8,1,?)',('all',))
 conn.execute("INSERT INTO conversation_members(conversation_id,user_id,last_read_message_id,pinned,notification_mode) VALUES(5,2,0,0,'mentions')")
 conn.execute("INSERT INTO messages(id,conversation_id,sender_id,text,file_id,client_id,created_at,updated_at) VALUES(8,5,1,'Old text',7,'legacy-message-8',100,100)")
 conn.execute("INSERT INTO messages(id,conversation_id,sender_id,text,reply_to,client_id,created_at,updated_at) VALUES(9,5,2,'Reply',8,'legacy-message-9',110,110)")
 conn.execute("INSERT INTO reactions(message_id,user_id,emoji) VALUES(8,2,'💜')")
 conn.execute("INSERT INTO calls(id,caller_id,callee_id,kind,status,created_at,answered_at,ended_at,end_reason,caller_heartbeat,callee_heartbeat) VALUES(12,1,2,'audio','ended',120,121,140,'completed',140,140)")
 conn.execute("INSERT INTO notification_settings(user_id,settings) VALUES(2,?)",(json.dumps({'sounds':False,'scale':'large'}),))
 conn.commit();conn.close();before=hashlib.sha256(source.read_bytes()).hexdigest()
 env=os.environ.copy();env['PINGUP_STORAGE_PATH']=str(storage/'target-private')
 def run(command,expected=0):
  p=subprocess.run([php,*command],cwd=root,env=env,text=True,capture_output=True)
  assert p.returncode==expected,(p.stdout,p.stderr)
  return p.stdout
 run(['bin/migrate.php']);run(['bin/import-sqlite.php','--source='+str(source)])
 proof=storage/'proof.php';proof.write_text('''<?php
 require '''+repr(str(root/'src/bootstrap.php'))+''';
 function ok($v,$name){if(!$v)throw new RuntimeException($name);}
 ok(query('SELECT password_hash FROM users WHERE id=1')->fetchColumn()==='unchanged-hash-fixture','password preserved');
 ok((int)query('SELECT avatar_file_id FROM users WHERE id=1')->fetchColumn()===7,'circular FK restored');
 ok(query('SELECT direct_key FROM conversations WHERE id=5')->fetchColumn()==='direct:1:2','conversation preserved');
 ok(query('SELECT notification_mode FROM conversation_members WHERE conversation_id=5 AND user_id=2')->fetchColumn()==='mentions','settings preserved');
 ok((int)query('SELECT COUNT(*) FROM reactions WHERE message_id=8')->fetchColumn()===1,'reactions preserved');
 ok((int)query('SELECT COUNT(*) FROM messages WHERE call_id=12')->fetchColumn()===1,'old call backfilled once');
 $log=normalizedMessage(query('SELECT * FROM messages WHERE call_id=12')->fetch(),2);
 ok($log['call']['duration']===19&&$log['call']['incoming'],'duration preserved');
 $id=insertId("INSERT INTO users(username,name,password_hash,last_seen,created_at) VALUES('fresh','Fresh','test',1,1)");ok($id>3,'identity advanced');
 $messages=normalizedMessages(query('SELECT * FROM messages WHERE id IN (8,9) ORDER BY id')->fetchAll(),1);ok($messages[1]['reply']['text']==='Old text','reply preserved');
 ok((int)query('SELECT size FROM files WHERE id=7')->fetchColumn()===5,'file reference preserved');
 echo "PASS: users/passwords/roles/avatars/members/messages/replies/reactions/settings/IDs/call history preserved; identity sequences advanced.\\n";
 ''')
 print(run([str(proof)]).strip())
 run(['bin/import-sqlite.php','--source='+str(source)],expected=1)
 assert hashlib.sha256(source.read_bytes()).hexdigest()==before,'Source modified'
 print('PASS: source byte-identical; repeat import into populated target refused without overwrite.')
