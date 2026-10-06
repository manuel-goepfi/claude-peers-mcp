import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.skipIf(!Bun.which("tmux") || !Bun.which("flock"))("custom socket runners and CLI callers share the pane allocation lock",async()=>{
  const root=mkdtempSync(join(tmpdir(),"pane-custom-lock-")),socket=join(root,"tmux"),worker=join(root,"worker.ts");
  const allocator=new URL("../bin/tmux-label-pane.ts",import.meta.url).pathname;
  const env={...process.env,TMUX:undefined,TMUX_PANE:undefined,CLAUDE_PEERS_TMUX_SOCKET:socket};
  const tmux=(args:string[])=>{
    const result=Bun.spawnSync(["tmux","-S",socket,...args],{env,stdout:"pipe",stderr:"pipe",timeout:3000});
    if(result.exitCode!==0)throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  // The real runner sees the correct socket while ambient configuration does
  // not. Allocation must happen through the locked child with lockSocket.
  writeFileSync(worker,`import {ensurePaneOperatorLabel} from ${JSON.stringify(allocator)};
const [socket,pane]=process.argv.slice(2);let directWrites=0;
const runner=(args:string[])=>{
  if(args[0]==="set-option")directWrites++;
  const result=Bun.spawnSync(["tmux","-S",socket!,...args],{stdout:"pipe",stderr:"ignore"});
  return {ok:result.exitCode===0,out:new TextDecoder().decode(result.stdout)};
};
const result=ensurePaneOperatorLabel(pane!,runner,socket);
console.log(JSON.stringify({result,directWrites}));
process.exitCode=result.status==="failed"?1:0;
`);
  try {
    tmux(["-f","/dev/null","new-session","-d","-s","Mixed","-x","240","-y","120","sleep","120"]);
    for(let i=0;i<5;i++)tmux(["split-window","-d","-t","Mixed","sleep","120"]);
    const panes=tmux(["list-panes","-s","-t","Mixed","-F","#{pane_id}"]).split("\n");
    const labels=await Promise.all(panes.map(async(pane,index)=>{
      const custom=index%2===0;
      const child=Bun.spawn(custom ? [process.execPath,worker,socket,pane] : [process.execPath,allocator,"--print",pane],
        {env:custom ? {...env,CLAUDE_PEERS_TMUX_SOCKET:join(root,"wrong-socket")} : env,stdout:"pipe",stderr:"pipe"});
      const [output,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);
      expect(code).toBe(0);
      if(!custom)return output.trim();
      const parsed=JSON.parse(output);
      expect(parsed.directWrites).toBe(0); // The old unlocked seam fails deterministically.
      expect(parsed.result.status).toBe("labeled");
      return parsed.result.label as string;
    }));
    expect(new Set(labels).size).toBe(panes.length);
    expect(labels.sort()).toEqual(["Mixed.1","Mixed.2","Mixed.3","Mixed.4","Mixed.5","Mixed.6"]);
    for(const pane of panes)expect(tmux(["show-options","-p","-t",pane,"-v","@operator_label"])).toMatch(/^Mixed\.[1-6]$/);
  } finally {
    Bun.spawnSync(["tmux","-S",socket,"kill-server"],{stdout:"ignore",stderr:"ignore"});
    rmSync(root,{recursive:true,force:true});
  }
},20000);
