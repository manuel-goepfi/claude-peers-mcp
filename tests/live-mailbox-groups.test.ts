import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createConnection, type Socket } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { startTestBroker } from "./helpers/test-broker.ts";
import { nearestNativeClaude } from "../shared/native-claude-proof.ts";

// A byte bridge only: the same real server stdio process remains connected.
class SocketStdio implements Transport {
  onmessage?: (message: JSONRPCMessage)=>void;
  onerror?: (error:Error)=>void;
  onclose?: ()=>void;
  private socket?:Socket;
  constructor(private path:string) {}
  async start() {
    const socket=this.socket=createConnection(this.path);let pending="";
    socket.on("data",data=>{pending+=data.toString();let end:number;
      while((end=pending.indexOf("\n"))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line)this.onmessage?.(JSON.parse(line));}});
    socket.on("error",e=>this.onerror?.(e));socket.on("close",()=>this.onclose?.());
    await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
  }
  async send(message:JSONRPCMessage){await new Promise<void>((resolve,reject)=>this.socket!.write(JSON.stringify(message)+"\n",e=>e?reject(e):resolve()));}
  async close(){this.socket?.end();}
}

async function until(predicate:()=>boolean) {for(let i=0;i<150;i++){if(predicate())return;await Bun.sleep(20);}throw new Error("fixture observation timeout");}

test.skipIf(!Bun.which("tmux")).each([false,true])("schema2 original maintained adapter preserves grouped mailbox across broker restart",async(accountMismatch)=>{
  const root=mkdtempSync(join(tmpdir(),"connected-companion-")),tmuxSocket=join(root,"tmux"),wire=join(root,"stdio"),pids=join(root,"pids"),ready=join(root,"native-ready");
  const script=join(root,"driver.py");
  // Initially unknown comm selects the server's existing legacy startup path.
  // It becomes recognizably native before ownership proof; no server code,
  // process, stdio connection, or peer token is replaced during the test.
  writeFileSync(script,`import ctypes,subprocess,sys,socket,os,time,signal,json
ctypes.CDLL(None).prctl(15,b'legacy-fixture',0,0,0)
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.bind(sys.argv[1]);s.listen(1)
open(sys.argv[2],'w').write(json.dumps({'native':os.getpid()}))
c,_=s.accept()
log=open(sys.argv[4],'w')
childenv=dict(os.environ)
if childenv.get("FIXTURE_FOREIGN_ACCOUNT")=="1":childenv["CLAUDE_CONFIG_DIR"]+="/foreign"
p=subprocess.Popen(sys.argv[5:],stdin=c,stdout=c,stderr=log,env=childenv)
open(sys.argv[2],'w').write(json.dumps({'native':os.getpid(),'adapter':p.pid}))
def stop(*_):
 p.terminate();p.wait();sys.exit(0)
signal.signal(signal.SIGTERM,stop)
while p.poll() is None:
 if os.path.exists(sys.argv[3]):ctypes.CDLL(None).prctl(15,b'claude',0,0,0)
 trigger=os.path.join(os.path.dirname(sys.argv[2]),'attest-hook')
 if os.path.exists(trigger):
  os.unlink(trigger)
  result=subprocess.run([sys.argv[5],${JSON.stringify(new URL("../hooks/register-peer-session.ts",import.meta.url).pathname)}],input=json.dumps({'session_id':'original-conversation','hook_event_name':'SessionStart','source':'resume'}),text=True,env=os.environ,stdout=log,stderr=log)
  open(os.path.join(os.path.dirname(sys.argv[2]),'attest-done'),'w').write(str(result.returncode))
 time.sleep(.01)
`);
  let broker=await startTestBroker({prefix:"connected-companion",cleanupOnStop:false});
  const db=new Database(broker.dbPath);
  let observedHeartbeats=0;
  const proxy=Bun.serve({hostname:"127.0.0.1",port:0,fetch:async request=>{
    const path=new URL(request.url).pathname;const response=await fetch(new Request(broker.url+path,request));
    if(path==="/heartbeat" && response.ok)observedHeartbeats++;
    return response;
  }});
  const env={...process.env,FIXTURE_FOREIGN_ACCOUNT:accountMismatch?"1":"0",HOME:root,CLAUDE_CONFIG_DIR:join(root,"claude"),CLAUDE_PEERS_PORT:String(proxy.port),CLAUDE_PEERS_DB:broker.dbPath,
    CLAUDE_PEERS_BRIDGE_TOKEN_FILE:broker.tokenPath,CLAUDE_PEERS_CLIENT_TYPE:"claude",CLAUDE_PEER_NAME:"Orch.1",CLAUDE_PEERS_TMUX_IDENTITY_MIRROR:"1",CLAUDE_PEERS_HEARTBEAT_MS:"1000",CLAUDE_PEERS_HEARTBEAT_PHASE_SPREAD:"0",
    TMUX:undefined,TMUX_PANE:undefined};
  const tmux=(...args:string[])=>Bun.spawnSync(["tmux","-S",tmuxSocket,...args],{env,stdout:"pipe",stderr:"ignore",timeout:3000});
  const call=async(path:string,body:object,token="")=>{const r=await fetch(broker.url+path,{method:"POST",headers:{"Content-Type":"application/json","X-Peer-Token":token},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
  const client=new Client({name:"existing-companion",version:"1"});
  const canonicalLabel=(pane:string)=>new TextDecoder().decode(tmux("display-message","-p","-t",pane,
    "#{@operator_label}").stdout).trim();
  const send=(id:string,text:string,key:string)=>client.callTool({name:"send_message",arguments:{to_id:id,message:text,request_id:key}});
  try {
    expect(tmux("-f","/dev/null","new-session","-d","-s","Orch","-c",root,"python3",script,wire,pids,ready,join(root,"adapter.log"),process.execPath,process.env.CLAUDE_PEERS_COMPAT_ADAPTER_PATH ?? new URL("../server.ts",import.meta.url).pathname).exitCode).toBe(0);
    await until(()=>existsSync(pids));
    const nativePid=JSON.parse(readFileSync(pids,"utf8")).native;
    const pane=new TextDecoder().decode(tmux("display-message","-p","-t","Orch","#{pane_id}").stdout).trim();
    const payload={pid:nativePid,cwd:root,git_root:null,tty:null,name:"Orch.1",tmux_session:"Orch",tmux_window_index:"0",tmux_window_name:"fixture",tmux_pane_id:pane,
      thread_id:"original-conversation",client_type:"claude",receiver_mode:"claude-channel",summary:""};
    const native=await call("/register",payload);
    const remote=await call("/register",{...payload,pid:process.pid,cwd:"/remote",name:"Remote.1",thread_id:null,tmux_session:null,tmux_pane_id:null,tmux_window_name:null,tmux_window_index:null,client_type:"unknown",receiver_mode:"manual-drain"});
    await Bun.sleep(1500); // Model reconnect: native lifetime predates this adapter.
    await client.connect(new SocketStdio(wire));
    const adapterPid=JSON.parse(readFileSync(pids,"utf8")).adapter;
    const alias=db.query("SELECT * FROM peers WHERE pid=?").get(adapterPid) as any;
    expect(alias.id).not.toBe(native.body.id);expect(alias.thread_id).toBeNull();
    expect((await send(remote.body.id,"before binding","before-request")).isError).not.toBe(true);
    expect((await call("/send-message",{id:remote.body.id,to_id:native.body.id,text:"native historical inbox",request_id:"native-inbox"},remote.body.token)).body.ok).toBe(true);
    expect((await call("/send-message",{id:native.body.id,to_id:remote.body.id,text:"native historical outgoing",request_id:"native-outgoing"},native.body.token)).body.ok).toBe(true);
    const before=db.query("SELECT * FROM messages ORDER BY id").all();
    writeFileSync(ready,"");await until(()=>nearestNativeClaude(adapterPid)?.pid===nativePid);
    const birth=nearestNativeClaude(adapterPid)!;
    const originalCreation=new Date(birth.bornAt+20).toISOString();
    expect(Date.parse(originalCreation)+1000).toBeLessThan(birth.callerBornAt);
    db.run("UPDATE peers SET registered_at=? WHERE id=?",[originalCreation,alias.id]);
    if(!accountMismatch){
      for(const [column,value,restore] of [
        ["registered_at",new Date(birth.bornAt-2000).toISOString(),originalCreation],
        ["thread_id","different-conversation",null],
        ["tmux_pane_id","%999999",pane],
      ] as const){
        db.run(`UPDATE peers SET ${column}=? WHERE id=?`,[value,alias.id]);
        expect((await call("/register",{...payload,adapter_pid:adapterPid,native_claude_companion:true})).status).toBe(409);
        expect(db.query("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
        db.run(`UPDATE peers SET ${column}=? WHERE id=?`,[restore,alias.id]);
      }
    }
    if(!accountMismatch){
      const nativeCreation=new Date(birth.bornAt-60000).toISOString();
      db.run("UPDATE peers SET registered_at=?,last_hook_seen_at=? WHERE id=?",[nativeCreation,new Date().toISOString(),native.body.id]);
      expect((await call("/identity-by-native-claude",{caller_pid:adapterPid})).status).toBe(409);
      expect((await call("/hook-heartbeat-by-thread",{thread_id:payload.thread_id,caller_pid:process.pid,client_type:"claude"})).status).toBe(409);
      expect((await call("/hook-heartbeat-by-thread",{thread_id:"wrong-conversation",caller_pid:adapterPid,client_type:"claude"})).status).toBe(404);
      expect((await call("/identity-by-native-claude",{caller_pid:adapterPid})).status).toBe(409);
      writeFileSync(join(root,"attest-hook"),"");
      await until(()=>existsSync(join(root,"attest-done")));
      expect(readFileSync(join(root,"attest-done"),"utf8")).toBe("0");
      expect((await call("/identity-by-native-claude",{caller_pid:adapterPid})).status).toBe(200);
      expect((db.query("SELECT registered_at FROM peers WHERE id=?").get(native.body.id) as any).registered_at).toBe(nativeCreation);
      expect(db.query("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
      const pinned=(db.query("SELECT seat_key FROM peers WHERE id=?").get(native.body.id) as any).seat_key;
      db.run("UPDATE peers SET seat_key=? WHERE id=?",[pinned.slice(0,-64)+"0".repeat(64),native.body.id]);
      expect((await call("/identity-by-native-claude",{caller_pid:adapterPid})).status).toBe(409);
      expect((await call("/hook-heartbeat-by-thread",{thread_id:payload.thread_id,caller_pid:adapterPid,client_type:"claude"})).status).not.toBe(200);
      db.run("UPDATE peers SET seat_key=? WHERE id=?",[pinned,native.body.id]);
    }
    if(accountMismatch)expect((await call("/hook-heartbeat-by-thread",{thread_id:payload.thread_id,caller_pid:adapterPid,client_type:"claude"})).status).toBe(409);
    const bound=await call("/register",{...payload,adapter_pid:adapterPid,native_claude_companion:true});
    if(accountMismatch){expect(bound.status).toBe(409);expect(db.query("SELECT * FROM messages ORDER BY id").all()).toEqual(before);expect((db.query("SELECT non_targetable FROM peers WHERE id=?").get(alias.id) as any).non_targetable).toBe(0);return;}
    expect(bound.status).toBe(200);
    expect((db.query("SELECT registered_at FROM peers WHERE id=?").get(alias.id) as any).registered_at).toBe(originalCreation);
    const firstBeat=observedHeartbeats;await until(()=>observedHeartbeats>firstBeat);await Bun.sleep(500);
    expect(canonicalLabel(pane)).toBe("Orch.1");
    expect((db.query("SELECT name,resolved_name FROM peers WHERE id=?").get(native.body.id) as any))
      .toEqual({name:"Orch.1",resolved_name:"Orch.1"});
    expect(db.query("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
    expect((db.query("SELECT token FROM peers WHERE id=?").get(alias.id) as any).token).toBe(alias.token);
    expect((await send(remote.body.id,"after binding","after-request")).isError).not.toBe(true);
    expect((db.query("SELECT from_id FROM messages WHERE request_id='after-request'").get() as any).from_id).toBe(alias.id);
    for(const path of ["/set-name","/reconcile-pane-thread"])
      expect((await call(path,{id:alias.id,name:"Wrong"},alias.token)).status).toBe(403);
    expect((await call("/heartbeat",{id:alias.id},alias.token)).status).toBe(200);
    expect((await call("/claim-by-pid",{pid:adapterPid,caller_pid:process.pid})).status).toBe(403);
    const answer=await call("/send-message",{id:remote.body.id,to_id:alias.id,text:"answer for original request",request_id:"answer",reply_to_id:"before-request"},remote.body.token);
    expect(answer.body.ok).toBe(true);
    const reply=await client.callTool({name:"get_reply_status",arguments:{request_id:"before-request"}});
    expect(reply.isError).not.toBe(true);expect(JSON.stringify(reply)).toContain("answer for original request");
    expect((await call("/send-message",{id:remote.body.id,to_id:alias.id,text:"drain through original transport",request_id:"inbound"},remote.body.token)).body.ok).toBe(true);
    const drained=await client.callTool({name:"check_messages",arguments:{}});
    expect(drained.isError).not.toBe(true);expect(JSON.stringify(drained)).toContain("drain through original transport");
    expect((db.query("SELECT delivered FROM messages WHERE request_id='inbound'").get() as any).delivered).toBe(1);
    const idsBeforeRename=db.query("SELECT id FROM peers ORDER BY id").all();
    expect(tmux("rename-session","-t","Orch","Renamed").exitCode).toBe(0);
    await until(()=>(db.query("SELECT name FROM peers WHERE id=?").get(native.body.id) as any)?.name==="Renamed.1");
    expect(canonicalLabel(pane)).toBe("Renamed.1");
    expect(db.query("SELECT id FROM peers ORDER BY id").all()).toEqual(idsBeforeRename);
    const routed=await call("/send-to-peer",{id:remote.body.id,selector:{name:"Renamed.1"},text:"canonical name route",request_id:"renamed-route"},remote.body.token);
    expect(routed.body.ok).toBe(true);
    expect((db.query("SELECT to_id FROM messages WHERE request_id='renamed-route'").get() as any).to_id).toBe(native.body.id);
    expect((await call("/send-to-peer",{id:remote.body.id,selector:{name:"Orch.1"},text:"obsolete name"},remote.body.token)).body.ok).toBe(false);
    const renamedDrain=await client.callTool({name:"check_messages",arguments:{}});
    expect(renamedDrain.isError).not.toBe(true);
    expect(JSON.stringify(renamedDrain)).toContain("canonical name route");
    const saved=db.query("SELECT seat_key,thread_id,tmux_pane_id FROM peers WHERE id=?").get(alias.id) as any;
    for(const [column,value] of [["seat_key",saved.seat_key.slice(0,-64)+"0".repeat(64)],["thread_id","foreign"],["tmux_pane_id","%999999"]] as const){
      db.run(`UPDATE peers SET ${column}=? WHERE id=?`,[value,alias.id]);
      expect((await call("/heartbeat",{id:alias.id},alias.token)).status).toBe(409);
      db.run(`UPDATE peers SET ${column}=? WHERE id=?`,[saved[column],alias.id]);
    }
    // The original server keeps its fixed proxy URL while the broker restarts.
    await broker.stop();
    broker=await startTestBroker({root:broker.root,dbPath:broker.dbPath,tokenPath:broker.tokenPath,cleanupOnStop:false});
    expect((await send(remote.body.id,"after broker restart","restart-request")).isError).not.toBe(true);
    expect(JSON.parse(readFileSync(pids,"utf8")).adapter).toBe(adapterPid);
    expect((db.query("SELECT token FROM peers WHERE id=?").get(alias.id) as any).token).toBe(alias.token);
    expect((await call("/unregister",{id:alias.id},alias.token)).status).toBe(200);
    expect((await call("/heartbeat",{id:alias.id},alias.token)).status).toBe(401);
    expect((await call("/claim-by-pid",{pid:adapterPid,caller_pid:adapterPid})).status).not.toBe(200);
    const history=db.query("SELECT * FROM messages ORDER BY id").all();
    const switched=await call("/register",{...payload,thread_id:"new-conversation"});
    expect(switched.status).toBe(200);
    expect(switched.body.id).not.toBe(native.body.id);
    expect((await call("/heartbeat",{id:native.body.id},native.body.token)).status).toBe(401);
    expect((await call("/send-message",{id:remote.body.id,to_id:alias.id,text:"must not cross thread"},remote.body.token)).body.ok).not.toBe(true);
    expect(db.query("SELECT * FROM messages ORDER BY id").all()).toEqual(history);
    const retired=db.query("SELECT token,non_targetable,seat_key FROM peers WHERE id IN (?,?) ORDER BY id").all(native.body.id,alias.id) as any[];
    expect(retired).toHaveLength(2);
    expect(retired.every(row=>row.token===null&&row.non_targetable===1&&row.seat_key===null)).toBe(true);
    const rebound=await call("/register",{...payload,thread_id:"new-conversation",adapter_pid:adapterPid,native_claude_companion:true});
    expect(rebound.status).toBe(200);
    expect(rebound.body.id).toBe(switched.body.id);
    expect((await call("/register-cli",{pid:adapterPid})).status).toBe(200);
    expect(db.query("SELECT id FROM peers WHERE id=?").get(alias.id)).not.toBeNull();
    expect((await call("/send-message",{id:remote.body.id,to_id:switched.body.id,text:"new conversation only",request_id:"new-thread"},remote.body.token)).body.ok).toBe(true);
    const fresh=await call("/poll-messages",{id:switched.body.id},switched.body.token);
    expect(fresh.status).toBe(200);
    expect(JSON.stringify(fresh.body)).toContain("new conversation only");
    expect(JSON.stringify(fresh.body)).not.toContain("native historical inbox");
    console.log("COMPAT transport before/after binding, drain, correlated reply, broker restart: PASS");
    // Maintained loaded mirror code is separately reported; mailbox ownership is independent.

  } finally {await client.close();proxy.stop(true);db.close();await broker.stop();tmux("kill-server");rmSync(root,{recursive:true,force:true});rmSync(broker.root,{recursive:true,force:true});}
},30000);
