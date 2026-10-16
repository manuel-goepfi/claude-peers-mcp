import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { startTestBroker, withoutHostTmux } from './helpers/test-broker.ts';

test('bridge-only complete seven-field roster preserves message response and authorization',async()=>{
 const broker=await startTestBroker({prefix:'bridge-roster',env:withoutHostTmux('/nonexistent/bridge-roster-fixture')});
 try{
  const db=new Database(broker.dbPath);const now=new Date().toISOString();
  db.run('INSERT INTO peers (id,pid,cwd,name,tmux_session,git_root,registered_at,last_seen,token,summary) VALUES (?,?,?,?,?,?,?,?,?,?)',['roster-fixture',process.pid,'/fixture',null,null,null,now,now,'peer-fixture-token','private-not-exported']);
  db.run('INSERT INTO peers (id,pid,cwd,name,tmux_session,git_root,registered_at,last_seen,token,summary) VALUES (?,?,?,?,?,?,?,?,?,?)',['second-fixture',process.pid,'/fixture2','fixture-name','fixture-session','/fixture-repo',now,now,'other-peer-token','private-other-summary']);db.close();
  const token=readFileSync(broker.tokenPath,'utf8').trim();
  for(const headers of [{},{Authorization:'Bearer wrong'},{'X-Peer-Token':'peer-fixture-token'},{Authorization:'Bearer peer-fixture-token'}] as Record<string,string>[]){
   const r=await fetch(broker.url+'/messages-since-id',{headers});expect(r.status).toBe(401);expect((await r.json() as any).peers).toBeUndefined();
  }
  const headers={Authorization:`Bearer ${token}`};
  const r=await fetch(broker.url+'/messages-since-id?since=0&limit=1',{headers});const b=await r.json() as any;
  expect(r.status).toBe(200);expect(b).toMatchObject({messages:[],cursor:0,limit:1,count:0});
  expect(b.peers).toEqual([{id:'roster-fixture',name:null,cwd:'/fixture',tmux_session:null,git_root:null,registered_at:now,last_seen:now},{id:'second-fixture',name:'fixture-name',cwd:'/fixture2',tmux_session:'fixture-session',git_root:'/fixture-repo',registered_at:now,last_seen:now}]);
  expect(Object.keys(b.peers[0]).sort()).toEqual(['id','name','cwd','tmux_session','git_root','registered_at','last_seen'].sort());
  expect(JSON.stringify(b)).not.toContain('private-not-exported');expect(JSON.stringify(b)).not.toContain('peer-fixture-token');
  const messages=new Database(broker.dbPath);
  messages.run('INSERT INTO messages (from_id,to_id,text,sent_at) VALUES (?,?,?,?)',['roster-fixture','second-fixture','old-compatible-message',now]);messages.close();
  const compatible=await fetch(broker.url+'/messages-since-id?since=0&limit=1',{headers}).then(r=>r.json()) as any;
  expect(compatible.count).toBe(1);expect(compatible.limit).toBe(1);expect(compatible.cursor).toBe(compatible.messages[0].id);expect(compatible.messages[0].text).toBe('old-compatible-message');expect(compatible.peers.length).toBe(2);
  let limited:Response|undefined;
  for(let i=0;i<605;i++){const response=await fetch(broker.url+'/messages-since-id',{headers});if(response.status===429){limited=response;break;}expect(response.status).toBe(200);}
  expect(limited?.status).toBe(429);expect(limited?.headers.get('Retry-After')).toBe('60');expect((await limited!.json() as any).peers).toBeUndefined();
 }finally{await broker.stop();expect(broker.proc.exitCode).not.toBeNull();console.error(JSON.stringify({evidence:'ISOLATED_FIXTURE_ONLY',pid:broker.proc.pid,port:broker.port,childExited:true,fixtureCleaned:true}));}
});
test('disabled bridge discloses no roster',async()=>{
 const broker=await startTestBroker({prefix:'bridge-roster-disabled',env:{...withoutHostTmux('/nonexistent/bridge-roster-fixture'),CLAUDE_PEERS_BRIDGE_ENABLED:'false'}});
 try{const r=await fetch(broker.url+'/messages-since-id');expect(r.status).toBe(404);expect(await r.json()).toEqual({error:'not found'});}finally{await broker.stop();}
});
