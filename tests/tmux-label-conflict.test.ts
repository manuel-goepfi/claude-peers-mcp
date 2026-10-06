import { expect,test } from "bun:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("physical prefix collisions repair deterministically including the canonical fast path",async()=>{
  const root=mkdtempSync(join(tmpdir(),"pane-label-conflict-")),socket=join(root,"tmux");
  const env={...process.env,TMUX:undefined,TMUX_PANE:undefined,CLAUDE_PEERS_TMUX_SOCKET:socket};
  const run=(args:string[])=>{
    const p=Bun.spawnSync(["tmux","-S",socket,...args],{env,stdout:"pipe",stderr:"pipe",timeout:3000});
    expect(p.exitCode).toBe(0);return new TextDecoder().decode(p.stdout).trim();
  };
  const label=async(...args:string[])=>{
    const p=Bun.spawn([process.execPath,new URL("../bin/tmux-label-pane.ts",import.meta.url).pathname,...args],{env,stdout:"pipe",stderr:"pipe"});
    const [out,exit]=await Promise.all([new Response(p.stdout).text(),p.exited]);expect(exit).toBe(0);return out.trim();
  };
  try {
    run(["-f","/dev/null","new-session","-d","-s","C5 Marketing","-x","200","-y","80","sleep","120"]);
    for(let i=0;i<2;i++)run(["split-window","-d","-t","C5 Marketing","sleep","120"]);
    const panes=run(["list-panes","-s","-t","C5 Marketing","-F","#{pane_id}"]).split("\n").sort((a,b)=>Number(a.slice(1))-Number(b.slice(1)));
    const [old,current,unique]=panes as [string,string,string];
    for(const [pane,name] of [[old,"marketing.1"],[current,"C5 Marketing.1"],[unique,"C5 Marketing.4"]])run(["set-option","-p","-t",pane!,"@operator_label",name!]);
    await label("--all");
    const names=()=>panes.map(p=>run(["show-options","-p","-t",p,"-v","@operator_label"]));
    expect(names()).toEqual(["C5 Marketing.5","C5 Marketing.1","C5 Marketing.4"]);
    await label("--all");expect(names()).toEqual(["C5 Marketing.5","C5 Marketing.1","C5 Marketing.4"]);
    // Both labels are already canonical: the fast path must still detect a
    // collision and repair the later pane even when it is requested first.
    run(["set-option","-p","-t",old,"@operator_label","C5 Marketing.1"]);
    expect(await label("--print",current)).toBe("C5 Marketing.5");
    expect(await label("--print",old)).toBe("C5 Marketing.1");
    expect(names()).toEqual(["C5 Marketing.1","C5 Marketing.5","C5 Marketing.4"]);
  } finally {Bun.spawnSync(["tmux","-S",socket,"kill-server"],{stdout:"ignore",stderr:"ignore"});rmSync(root,{recursive:true,force:true});}
},20000);
