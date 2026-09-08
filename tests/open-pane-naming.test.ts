import { expect,test } from "bun:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishBrokerIdentityToTmux } from "../shared/tmux-identity.ts";
import { peerName } from "../hooks/register-peer-session.ts";

test.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("concurrent open panes own unique ordinals through close and session rename",async()=>{
  const root=mkdtempSync(join(tmpdir(),"open-pane-names-")),socket=join(root,"tmux");
  const env={...process.env,TMUX:undefined,TMUX_PANE:undefined,CLAUDE_PEERS_TMUX_SOCKET:socket};
  const run=(args:string[])=>{
    const r=Bun.spawnSync(["tmux","-S",socket,...args],{env,stdout:"pipe",stderr:"pipe",timeout:3000});
    if(r.exitCode!==0)throw Error(new TextDecoder().decode(r.stderr));
    return new TextDecoder().decode(r.stdout).trim();
  };
  const command=new URL("../bin/tmux-label-pane.ts",import.meta.url).pathname;
  const label=async(pane:string)=>{
    const p=Bun.spawn([process.execPath,command,"--print",pane],{env,stdout:"pipe",stderr:"pipe"});
    const [out,exit]=await Promise.all([new Response(p.stdout).text(),p.exited]);expect(exit).toBe(0);return out.trim();
  };
  const read=(pane:string,opt:string)=>run(["show-options","-p","-t",pane,"-v",opt]);
  try {
    run(["-f","/dev/null","new-session","-d","-s","Open Names","-x","240","-y","120","sleep","120"]);
    for(let i=0;i<5;i++)run(["split-window","-d","-t","Open Names","sleep","120"]);
    const panes=run(["list-panes","-s","-t","Open Names","-F","#{pane_id}"]).split("\n");
    const names=await Promise.all(panes.map(label));
    expect(new Set(names).size).toBe(6);
    expect(names.map(n=>Number(n.split(".").at(-1))).sort((a,b)=>a-b)).toEqual([1,2,3,4,5,6]);
    const highest=panes[names.indexOf("Open Names.6")]!;
    run(["kill-pane","-t",highest]);
    const replacement=run(["split-window","-d","-P","-F","#{pane_id}","-t",panes.find(p=>p!==highest)!,"sleep","120"]);
    expect(await label(replacement)).toBe("Open Names.6");
    const survivors=panes.filter(p=>p!==highest);
    for(const pane of survivors)expect(await label(pane)).toBe(names[panes.indexOf(pane)]!);
    run(["rename-session","-t","Open Names","Renamed Session"]);
    await Promise.all([...survivors,replacement].map(label));
    for(const pane of survivors)expect(read(pane,"@operator_label")).toBe(names[panes.indexOf(pane)]!.replace("Open Names.","Renamed Session."));
    const pane=survivors[0]!,canonical=read(pane,"@operator_label");
    const result=publishBrokerIdentityToTmux({id:"old-adapter",name:"Old.99",resolved_name:"Old.100",client_type:"claude",receiver_mode:"claude-channel"},
      {session:"Old",pane_id:pane},{updateOperatorLabel:true,readPaneOption:read,setPaneOption:(target,opt,value)=>{run(["set-option","-p","-t",target,opt,value]);return true;}});
    expect(result.ok).toBe(true);
    expect(read(pane,"@operator_label")).toBe(canonical);
    expect(read(pane,"@peer_label")).toBe(canonical);
    expect(peerName("claude",1,{session:"Renamed Session",pane_id:pane},{CLAUDE_PEER_NAME:"Old.99"},canonical)).toBe(canonical);
  } finally {
    Bun.spawnSync(["tmux","-S",socket,"kill-server"],{stdout:"ignore",stderr:"ignore"});rmSync(root,{recursive:true,force:true});
  }
},20000);
