// Native portable-app update test. Selectors, release files and fixture fields
// come from a private case description. Only verification results go to CI logs.
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const cfg=JSON.parse(process.env.CASE_DATA);
delete process.env.CASE_DATA;
const work=mkdtempSync(path.join(process.env.RUNNER_TEMP,'installed-update-'));
const env={...process.env,CASE_DIR:work,CASE_EXE:cfg.exe,CASE_ZIP:cfg.zip};
const ps=(script)=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; "+script],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const get=(obj,key)=>key.split('.').reduce((o,k)=>o?.[k],obj);
const check=(condition,message)=>{if(!condition)throw Error(message)};
async function wait(fn,reason,ms=45000){
 const end=Date.now()+ms;
 while(Date.now()<end){const val=await fn(); if(val)return val; await sleep(200);}
 throw Error(reason);
}
function checksum(file){return createHash('sha256').update(readFileSync(file)).digest('hex')}
const exe=path.join(work,'portable',cfg.exe), appdir=path.dirname(exe);
function nativePid(){return Number(ps('$path=Join-Path (Join-Path $env:CASE_DIR portable) $env:CASE_EXE; (Get-Process | Where-Object {$_.Path -eq $path -and $_.MainWindowHandle -ne 0} | Select-Object -First 1).Id'))}
let stage='download',browser,ui,view;
const labels=()=>ui.evaluate(()=>[...window.acceptanceLabels.values()]);
async function clickLabel(text){
 const pos=(await labels()).find(l=>l.text===text);
 if(!pos)return false;
 await ui.mouse.click(pos.x,pos.y);return true;
}
async function connectView(){
 const endpoint='http://127.0.0.1:9245';
 await wait(()=>fetch(endpoint+'/json/version').then(r=>r.ok).catch(()=>false),'WebView endpoint unavailable');
 browser=await chromium.connectOverCDP(endpoint,{timeout:20000});
 ui=await wait(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:')),'Application window unavailable');
 await ui.bringToFront();
 view=undefined;
 const packet=raw=>{
   for(const part of String(raw).split('\x1e')){
    if(!part.startsWith('42['))continue;
    try {const [name,data]=JSON.parse(part.slice(2)); if(name===cfg.event && data?.[cfg.matchKey]===cfg.matchValue && (!view || data[cfg.orderKey]>=view[cfg.orderKey]))view=data;} catch{}
   }
 };
 const cdp=await ui.context().newCDPSession(ui);
 cdp.on('Network.webSocketFrameReceived', e=>packet(e.response.payloadData));
 await cdp.send('Network.enable');
 ui.on('response',async res=>{if(res.url().includes('transport=polling')&&res.request().method()==='GET'){try{packet(await res.text())}catch{}}});
 await ui.locator('canvas').waitFor();
 await ui.evaluate(()=>{
   if(window.acceptanceLabels)return;
   const p=CanvasRenderingContext2D.prototype, draw=p.fillText,clear=p.clearRect;
   const entries=new Map();window.acceptanceLabels=entries;
   p.clearRect=function(...v){if(v[2]>250&&v[3]>250)entries.clear();return clear.apply(this,v)};
   p.fillText=function(t,x,y,...rest){
    const b=this.canvas.getBoundingClientRect(),m=this.getTransform();
    const at={text:String(t),font:this.font,x:b.x+(m.a*x+m.c*y+m.e)*b.width/this.canvas.width,y:b.y+(m.b*x+m.d*y+m.f)*b.height/this.canvas.height};
    entries.set([at.text,at.x,at.y].join('|'),at);return draw.call(this,t,x,y,...rest);
   };
 });
}
async function steps(list){
 for(const s of list){
   if(s.seen){await wait(async()=>(await labels()).some(l=>l.text===s.seen),"Expected canvas text missing");continue}
   if(s.untilLabel){await wait(async()=>{const all=await labels(); if(all.some(l=>l.text===s.untilLabel))return true;for(const button of s.close??[]){if(await clickLabel(button))break;}return false},"Restored controls unavailable"); continue}
   if(s.label){await wait(()=>clickLabel(s.label),'Canvas control unavailable');continue}
   const elem=ui.locator(s.selector);
   if(s.value!==undefined)await elem.fill(s.value);
   else if(s.text!==undefined)await wait(async()=>await elem.isVisible() && (await elem.textContent())===s.text,'Expected visible text missing');
   else await elem.click();
 }
}
function snapshot(v) {
 const rows=get(v,cfg.rows), ids=rows.map(r=>r[cfg.id]), own=rows.find(r=>r[cfg.id]===v[cfg.self]);
 return {context:cfg.context.map(k=>get(v,k)),roster:ids,position:ids.indexOf(v[cfg.self]),held:cfg.held.map(k=>get(v,k)),personal:cfg.personal.map(k=>get(own,k))};
}
async function prepare(){
 let lastAction=0;
 for(const end=Date.now()+cfg.prepareMs;Date.now()<end;){
  if(view && view[cfg.phaseKey]===cfg.phase && get(view,cfg.requiredList)?.length && view[cfg.rows].find(r=>r[cfg.id]===view[cfg.self])?.[cfg.activeKey]){
   const before=snapshot(view);
   check(before.position>=0 && before.roster.length===cfg.count,'Unexpected initial roster'); return before;
  }
  if(Date.now()-lastAction>600){
   const painted=await labels();
   let hit,clickCount=1;
   for(const action of cfg.actions){
    if(action.if && !action.if.every(([key,value])=>get(view,key)===value))continue;
    if(action.same && get(view,action.same[0])!==get(view,action.same[1]))continue;
    if(action.fromList){
      const items=get(view,action.fromList)??[];
      const choices=items.filter(r=>action.filters.every(([k,v])=>get(r,k)===v)).map(r=>String(get(r,action.itemKey)).replace(action.prefix,''));
      const candidates=painted.filter(l=>choices.includes(l.text) && l.font.includes(action.font));
      hit=candidates[Math.floor(Math.random()*candidates.length)];
    } else { hit=painted.find(l=>l.text===action.label && (!action.font || l.font.includes(action.font))); }
    if(hit){clickCount=action.count??1;break}
   }
   if(hit){await ui.mouse.click(hit.x,hit.y,{clickCount,delay:45});lastAction=Date.now();}
  }
  await sleep(160);
 }
 throw Error('Initial nonempty session fixture did not become ready');
}
try{
 ps("Invoke-WebRequest -UseBasicParsing $env:CASE_ZIP -OutFile (Join-Path $env:CASE_DIR app.zip)");
 check(checksum(path.join(work,'app.zip'))===cfg.sha,'Old archive digest mismatch');
 ps("Expand-Archive (Join-Path $env:CASE_DIR app.zip) (Join-Path $env:CASE_DIR portable); $p=Join-Path (Join-Path $env:CASE_DIR portable) $env:CASE_EXE; Start-Process -FilePath $p -WorkingDirectory (Split-Path $p)");
 stage='initial native launch';const oldPid=await wait(nativePid,'Old native window missing'); await connectView();
 await steps(cfg.join); console.log('Verified old installed version and joined the live session.');
 stage='prepare nonempty inventory';const before=await prepare();
 console.log('Baseline: '+before.roster.length+' participants; seat '+(before.position+1)+'; '+before.held[0].length+' private inventory entries.');
 stage='check update';await steps(cfg.check);
 stage='install via visible control';await ui.locator(cfg.install).click({timeout:10000,noWaitAfter:true}).catch(()=>{});
 const newPid=await wait(()=>{const p=nativePid();return p && p!==oldPid && p},'No replacement native window',135000);
 check(ps('Get-Process -Id '+oldPid+' -ErrorAction SilentlyContinue | ForEach-Object Id; exit 0')==='','Old native process still running');
 for(const [name,digest] of Object.entries(cfg.expected))check(checksum(path.join(appdir,name))===digest,'Installed member digest mismatch');
 console.log('Original native process exited. Replacement process opened at the same path. All installed files match the target ZIP.');
 stage='first launch changelog';await connectView();await steps(cfg.after);
 const notes=await ui.locator(cfg.notesSelector).allTextContents();
 check(isDeepStrictEqual(notes,cfg.notes),'Release note text mismatch');
 console.log('New process displayed the target release and every expected changelog entry before dismissing the dialog.');
 await steps(cfg.dismiss);
 stage='restored live session';
 await wait(()=>view && view[cfg.phaseKey]===cfg.phase && isDeepStrictEqual(snapshot(view),before),'Restored version did not receive the same live snapshot',60000);
 await steps(cfg.verifyUI);
 console.log('Live room, round, seat ID and index, participant order, identity, and full inventory instances match. Application UI displays the connected original session.');
} catch(e) {
 // Playwright errors may contain rendered personal data, URLs or local paths.
 console.error('Failed stage: '+stage+'. '+(e.name==='Error' && /^[a-zA-Z0-9 ,.-]{1,110}$/.test(e.message) ? e.message : 'Control did not reach expected state.'));
 process.exitCode=1;
} finally{
 try{ps('$p=Join-Path (Join-Path $env:CASE_DIR portable) $env:CASE_EXE; Get-Process | Where-Object {$_.Path -eq $p} | Stop-Process -Force')}catch{}
}
