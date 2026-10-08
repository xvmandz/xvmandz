#!/usr/bin/env python3
"""Competing PHP processes / PostgreSQL connections on an empty pingup_test_* DB."""
import os,pathlib,tempfile,subprocess,time,json
root=pathlib.Path(__file__).resolve().parents[1];php=os.environ.get('PINGUP_TEST_PHP','php')
assert 'dbname=pingup_test_' in os.environ.get('PINGUP_DATABASE_DSN','')
helper=str(root/'tests/concurrency.php')
def run(*args):return subprocess.run([php,helper,*args],cwd=root,check=True,capture_output=True,text=True).stdout
subprocess.run([php,str(root/'bin/migrate.php')],check=True);run('seed')
with tempfile.TemporaryDirectory(prefix='pingup-concurrency-') as temp:
 for mode in ['send','call']:
  gate=pathlib.Path(temp)/(mode+'-gate');workers=[]
  for i in range(2):workers.append((subprocess.Popen([php,helper,mode,str(gate),temp+'/'+mode+str(i),str(1 if i==0 else 3)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True),pathlib.Path(temp)/(mode+str(i))))
  deadline=time.monotonic()+4
  while not all(ready.exists() for _,ready in workers):
   assert time.monotonic()<deadline;time.sleep(.01)
  gate.touch();results=[]
  for worker,_ in workers:
   out,err=worker.communicate(timeout=10);assert worker.returncode==0,err;results.append(json.loads(out))
  if mode=='send':assert results[0]['id']==results[1]['id'],results
  else:assert sum('id' in r for r in results)==1 and any(r.get('error')=='call_busy' for r in results),results
 print(run('proof').strip())
