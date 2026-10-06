import { Database } from "bun:sqlite";
import { expect,test } from "bun:test";
import { copyFileSync,chmodSync } from "node:fs";
import { join } from "node:path";
import { startTestBroker } from "./helpers/test-broker.ts";

test.skipIf(!Bun.which("tmux"))("empty native Codex duplicate unregisters and threadless reconnect retains the exact keeper",async()=>{
  const broker=await startTestBroker({prefix:"codex-empty-duplicate"});
  const db=new Database(broker.dbPath),session=`empty-duplicate-${process.pid}`;
  const binary=join(broker.root,"codex");copyFileSync("/usr/bin/sleep",binary);chmodSync(binary,0o755);
  const run=(args:string[])=>{const r=Bun.spawnSync(["tmux",...args],{stdout:"pipe",stderr:"pipe"});expect(r.exitCode).toBe(0);return r.stdout.toString().trim();};
  const call=async(path:string,body:object,token="")=>{const r=await fetch(broker.url+path,{method:"POST",headers:{"Content-Type":"application/json","X-Peer-Token":token},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
  try {
    run(["-f","/dev/null","new-session","-d","-s",session,binary,"120"]);
    const [pid,pane]=run(["display-message","-p","-t",session,"#{pane_pid}\t#{pane_id}"]).split("\t");
    const registration={pid:Number(pid),cwd:broker.root,git_root:null,tty:null,name:"Codex.1",tmux_session:session,tmux_pane_id:pane,client_type:"codex",receiver_mode:"codex-hook",thread_id:crypto.randomUUID()};
    const keeper=await call("/register",registration);expect(keeper.status).toBe(200);
    const duplicate=()=>db.run(`INSERT INTO peers(id,pid,cwd,git_root,tty,name,resolved_name,tmux_session,tmux_pane_id,client_type,receiver_mode,thread_id,registered_at,last_seen,token)
      SELECT 'duplicate',pid,cwd,git_root,tty,name,name,tmux_session,tmux_pane_id,client_type,'manual-drain',NULL,registered_at,last_seen,'duplicate-token' FROM peers WHERE id=?`,[keeper.body.id]);
    db.run("INSERT INTO messages(from_id,to_id,text,sent_at,delivered) VALUES (?,'remote','keeper outgoing','now',1)",[keeper.body.id]);
    db.run("INSERT INTO messages(from_id,to_id,text,sent_at,delivered) VALUES ('remote',?,'keeper incoming','now',0)",[keeper.body.id]);
    const history=db.query("SELECT * FROM messages").all();
    duplicate();
    expect((await call("/unregister",{id:"duplicate"},"duplicate-token")).status).toBe(200);
    expect(db.query("SELECT id FROM peers WHERE id='duplicate'").get()).toBeNull();
    expect((await call("/heartbeat",{id:"duplicate"},"duplicate-token")).status).toBe(401);
    const reconnect={...registration,thread_id:null,receiver_mode:"manual-drain",name:"stale.9"};
    for(let i=0;i<3;i++) {
      const recovered=await call("/register",reconnect);
      expect(recovered.status).toBe(200);expect(recovered.body).toMatchObject({id:keeper.body.id,token:keeper.body.token,name:keeper.body.name,receiver_mode:keeper.body.receiver_mode});
      expect((await call("/heartbeat",{id:keeper.body.id},keeper.body.token)).status).toBe(200);
    }
    expect(db.query("SELECT COUNT(*) AS n FROM peers WHERE pid=?").get(Number(pid))).toEqual({n:1});
    // Registration itself also cleans a pre-existing empty duplicate atomically.
    duplicate();expect((await call("/register",reconnect)).body.id).toBe(keeper.body.id);
    expect(db.query("SELECT id FROM peers WHERE id='duplicate'").get()).toBeNull();
    expect(db.query("SELECT * FROM messages").all()).toEqual(history);
    expect((await call("/register",{...reconnect,adapter_pid:process.pid})).status).toBe(409);
    expect((await call("/register",{...reconnect,tmux_pane_id:"%999999"})).status).toBe(409);
    const registeredAt=(db.query("SELECT registered_at FROM peers WHERE id=?").get(keeper.body.id) as {registered_at:string}).registered_at;
    db.run("UPDATE peers SET registered_at='2000-01-01T00:00:00.000Z' WHERE id=?",[keeper.body.id]);
    duplicate();
    expect((await call("/register",reconnect)).status).toBe(409);
    expect((await call("/unregister",{id:"duplicate"},"duplicate-token")).status).toBe(200);
    expect(db.query("SELECT id FROM peers WHERE id='duplicate'").get()).not.toBeNull();
    db.run("DELETE FROM peers WHERE id='duplicate'");
    db.run("UPDATE peers SET registered_at=? WHERE id=?",[registeredAt,keeper.body.id]);
    // Delivered incoming and outgoing history are each independently enough to
    // forbid retirement; no pending-only shortcut may erase historical owners.
    for(const direction of ["incoming","outgoing"]) {
      duplicate();
      db.run("INSERT INTO messages(from_id,to_id,text,sent_at,delivered) VALUES (?,?,?,'now',1)",direction==="incoming"?["remote","duplicate",direction]:["duplicate","remote",direction]);
      const snapshot=db.query("SELECT * FROM messages").all();
      expect((await call("/unregister",{id:"duplicate"},"duplicate-token")).status).toBe(200);
      expect(db.query("SELECT id FROM peers WHERE id='duplicate'").get()).not.toBeNull();
      expect((await call("/register",reconnect)).status).toBe(409);
      expect(db.query("SELECT * FROM messages").all()).toEqual(snapshot);
      db.run("DELETE FROM messages WHERE from_id='duplicate' OR to_id='duplicate'");db.run("DELETE FROM peers WHERE id='duplicate'");
    }
    duplicate();db.run("UPDATE peers SET thread_id=? WHERE id='duplicate'",[crypto.randomUUID()]);
    expect((await call("/register",reconnect)).status).toBe(409);
    expect(db.query("SELECT COUNT(*) AS n FROM peers WHERE pid=?").get(Number(pid))).toEqual({n:2});
    expect(db.query("SELECT * FROM messages").all()).toEqual(history);
  } finally {Bun.spawnSync(["tmux","kill-session","-t",session],{stdout:"ignore",stderr:"ignore"});db.close();await broker.stop();}
},20000);
