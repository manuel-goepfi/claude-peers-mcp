import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Peer } from "./types.ts";
import { nearestNativeClaude } from "./native-claude-proof.ts";
import { currentSeatProcessKey,proveSeatRuntime,type SeatRuntimeProof } from "./live-runtime-proof.ts";

type Row=Peer & {token:string|null};
export function liveGroupPrefix(key:string|null|undefined):string|null {
  return typeof key==="string" && /^live:[a-f0-9]{64}:(native|alias):[a-f0-9]{64}$/.test(key) ? key.slice(0,69):null;
}
export const liveMailboxIdsSql=`SELECT sibling.id FROM peers owner JOIN peers sibling ON sibling.id=owner.id
  OR (substr(owner.seat_key,1,5)='live:' AND substr(owner.seat_key,1,69)=substr(sibling.seat_key,1,69)) WHERE owner.id=?`;
function groupKey(peer:Row,proof:SeatRuntimeProof):string {
  return `live:${createHash("sha256").update(JSON.stringify([proof.account_key,proof.runtime_key,proof.process_key,peer.thread_id!.toLowerCase()])).digest("hex")}`;
}

/** Runtime-scoped mailbox membership, stored entirely in existing schema2 rows.
 * A group never reserves a display name or transfers to another native process. */
export class LiveMailboxGroups {
  constructor(private db:Database) {}
  private row(id:string){return this.db.query("SELECT * FROM peers WHERE id=?").get(id) as Row|null;}
  nativeIdentity(callerPid:number) { return this.inspectNative(callerPid); }
  private inspectNative(callerPid:number,hookThread?:string) {
    const ancestry=nearestNativeClaude(callerPid);
    if(!ancestry)throw new Error("native Claude ancestry unavailable");
    const rows=this.db.query("SELECT * FROM peers WHERE pid=? AND client_type='claude' AND non_targetable=0 AND thread_id IS NOT NULL AND length(thread_id)>0").all(ancestry.pid) as Row[];
    if(rows.length!==1)throw new Error("native Claude thread missing or ambiguous");
    const peer=rows[0]!,born=Date.parse(peer.registered_at),proof=proveSeatRuntime(peer);
    if(!peer.token || !Number.isFinite(born) || !proof)throw new Error("native runtime/account proof unavailable");
    const prefix=groupKey(peer,proof);
    if(liveGroupPrefix(peer.seat_key) && peer.seat_key!==`${prefix}:native:${proof.process_key}`)throw new Error("native runtime group expired");
    const pinned=peer.seat_key===`${prefix}:native:${proof.process_key}`;
    if(hookThread!==undefined){
      const caller=proveSeatRuntime({pid:callerPid,tmux_pane_id:peer.tmux_pane_id,client_type:"claude"});
      if(hookThread.toLowerCase()!==peer.thread_id!.toLowerCase() || callerPid===peer.pid || !caller
        || caller.account_key!==proof.account_key || caller.runtime_key!==proof.runtime_key)
        throw new Error("native hook conversation/runtime mismatch");
    }else if(!pinned && born+1000<ancestry.bornAt)throw new Error("native runtime/account proof unavailable");
    return {peer,proof,prefix,callerBornAt:ancestry.callerBornAt,nativeBornAt:ancestry.bornAt};
  }
  /** Only a current descendant hook carrying the exact session can establish
   * resumed ownership. Legacy health timestamps never establish this proof. */
  attestNativeHook(callerPid:number,thread:string,expectedId:string) {
    const found=this.inspectNative(callerPid,thread);
    if(found.peer.id!==expectedId || currentSeatProcessKey(found.peer.pid)!==found.proof.process_key)
      throw new Error("native hook owner changed");
    const key=`${found.prefix}:native:${found.proof.process_key}`;
    this.db.run("UPDATE peers SET seat_key=? WHERE id=? AND seat_key IS NOT ?",[key,found.peer.id,key]);
  }
  current(id:string):{peer:Row;native:Row;proof:SeatRuntimeProof}|null {
    try{
      const peer=this.row(id),prefix=liveGroupPrefix(peer?.seat_key);
      if(!peer || !prefix || !peer.token || currentSeatProcessKey(peer.pid)!==peer.seat_key!.split(":")[3])return null;
      const {peer:native,proof,prefix:actual,nativeBornAt}=this.nativeIdentity(peer.pid);
      if(actual!==prefix)return null;
      if(peer.id===native.id)return peer.non_targetable===0?{peer,native,proof}:null;
      const own=proveSeatRuntime(peer);
      if(peer.non_targetable!==1 || peer.client_type!=="claude" || !own || own.account_key!==proof.account_key || own.runtime_key!==proof.runtime_key
        || (peer.thread_id && peer.thread_id.toLowerCase()!==native.thread_id!.toLowerCase())
        || !Number.isFinite(Date.parse(peer.registered_at)) || Date.parse(peer.registered_at)+1000<nativeBornAt)return null;
      return {peer,native,proof};
    }catch{return null;}
  }
  target(id:string):Row|null {
    const peer=this.row(id),prefix=liveGroupPrefix(peer?.seat_key);if(!prefix)return null;
    const natives=this.db.query("SELECT id FROM peers WHERE substr(seat_key,1,69)=? AND non_targetable=0").all(prefix) as Array<{id:string}>;
    if(natives.length!==1)return null;
    return this.current(natives[0]!.id)?.native ?? null;
  }
  /** Retire a proved mailbox group when the same native process moves to a
   * different conversation. Historical IDs and messages remain, but no old
   * token or seat membership can cross into the new conversation. */
  retire(id:string):boolean {
    const current=this.current(id);if(!current)return false;
    const prefix=liveGroupPrefix(current.native.seat_key);if(!prefix)return false;
    this.db.transaction(()=>{
      this.db.run("UPDATE peers SET token=NULL,non_targetable=1,seat_key=NULL,seat_pids='[]' WHERE substr(seat_key,1,69)=?",[prefix]);
    })();
    return true;
  }
  bind(callerPid:number,nativePid:number,thread:string) {
    const found=this.nativeIdentity(callerPid),{peer:native,proof,prefix}=found;
    if(native.pid!==nativePid || native.thread_id!.toLowerCase()!==thread.toLowerCase() || callerPid===nativePid)throw new Error("companion conversation mismatch");
    const own=proveSeatRuntime({pid:callerPid,tmux_pane_id:native.tmux_pane_id,client_type:"claude"});
    if(!own || own.account_key!==proof.account_key || own.runtime_key!==proof.runtime_key)throw new Error("companion account/runtime mismatch");
    return this.db.transaction(()=>{
      const aliases=this.db.query("SELECT * FROM peers WHERE pid=? AND id<>? AND token IS NOT NULL").all(callerPid,native.id) as Row[];
      // Legacy reconnects preserve row creation time while replacing adapter PID.
      // History must originate within this same independently proven native life;
      // the enrolled alias key separately pins the current adapter process birth.
      for(const alias of aliases){
        const born=Date.parse(alias.registered_at),oldPrefix=liveGroupPrefix(alias.seat_key);
        if(alias.client_type!=="claude" || alias.tmux_pane_id!==native.tmux_pane_id || !Number.isFinite(born) || born+1000<found.nativeBornAt
          || (alias.thread_id && alias.thread_id.toLowerCase()!==thread.toLowerCase()) || (oldPrefix && (oldPrefix!==prefix || alias.seat_key!==`${prefix}:alias:${own.process_key}`)))throw new Error("companion history ownership mismatch");
      }
      const members=this.db.query("SELECT id FROM peers WHERE substr(seat_key,1,69)=?").all(prefix) as Array<{id:string}>;
      const ids=JSON.stringify([...new Set([native.id,...aliases.map(p=>p.id),...members.map(p=>p.id)])]);
      for(const [owner,key]of[["from_id","request_id"],["to_id","reply_to_id"]]as const){
        if(this.db.query(`SELECT 1 FROM messages WHERE ${owner} IN (SELECT value FROM json_each(?)) AND ${key} IS NOT NULL GROUP BY ${key} HAVING COUNT(*)>1 LIMIT 1`).get(ids))throw new Error("ambiguous companion correlation history");
      }
      const pendingBefore=Number((this.db.query(`SELECT COUNT(*) AS n FROM messages WHERE to_id IN (${liveMailboxIdsSql}) AND delivered=0`).get(native.id) as {n:number}).n);
      let pids:number[]=[];try{const raw:unknown=JSON.parse(native.seat_pids??"[]");if(Array.isArray(raw))pids=raw.filter(v=>Number.isInteger(v)&&v>1);}catch{}
      this.db.run("UPDATE peers SET seat_key=?,seat_pids=? WHERE id=?",[`${prefix}:native:${proof.process_key}`,JSON.stringify([...new Set([...pids,native.pid,callerPid])]),native.id]);
      for(const alias of aliases)this.db.run("UPDATE peers SET seat_key=?,non_targetable=1 WHERE id=?",[`${prefix}:alias:${own.process_key}`,alias.id]);
      const pendingAfter=Number((this.db.query(`SELECT COUNT(*) AS n FROM messages WHERE to_id IN (${liveMailboxIdsSql}) AND delivered=0`).get(native.id) as {n:number}).n);
      if(!pendingBefore&&pendingAfter)this.db.run("UPDATE peers SET unread_episode=unread_episode+1 WHERE id=?",[native.id]);
      return {native:this.row(native.id)!,proof};
    })();
  }
}
