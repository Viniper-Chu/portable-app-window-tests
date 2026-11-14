import assert from 'node:assert/strict';
const cfg=JSON.parse(process.env.APP_CONFIG);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async fn=>{const end=Date.now()+45000;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await sleep(250)}throw Error('UI condition timed out')};
const target=await until(async()=>(await(await fetch('http://127.0.0.1:9245/json/list')).json()).find(t=>t.type==='page' && t.url.includes('127.0.0.1')));
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});let seq=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m);pending.delete(m.id);};
async function send(method,params){const id=++seq;const reply=new Promise(ok=>pending.set(id,ok));ws.send(JSON.stringify({id,method,params}));const m=await reply;assert(!m.error);return m.result}
async function evaluate(expression){let r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Evaluation failed');return r.result.value}
try{
 await until(()=>evaluate('document.readyState==="complete" && !!document.querySelector("canvas")'));
 await evaluate(`(()=>{const p=CanvasRenderingContext2D.prototype,f=p.fillText,c=p.clearRect;window.testLabels=new Map();p.clearRect=function(...v){if(v[2]>250&&v[3]>250)testLabels.clear();return c.apply(this,v)};p.fillText=function(t,x,y,...a){const b=this.canvas.getBoundingClientRect(),m=this.getTransform();testLabels.set(t,{x:b.x+(x*m.a+m.e)*b.width/this.canvas.width,y:b.y+(y*m.d+m.f)*b.height/this.canvas.height});return f.call(this,t,x,y,...a)}})()`);
 for (const [i,s] of cfg.steps.entries()) {
  if(s.selector){await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(s.selector)})?.getClientRects().length`));
   if(s.value)await evaluate(`(()=>{let e=document.querySelector(${JSON.stringify(s.selector)});e.value=${JSON.stringify(s.value)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
   else await evaluate(`document.querySelector(${JSON.stringify(s.selector)}).click()`);
  } else {
   const pos=await until(()=>evaluate(`window.testLabels.get(${JSON.stringify(s.label)})`));
   if(s.click){await send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});}
  }
  console.log('Verified interaction',i+1);
 }
}finally{ws.close()}
