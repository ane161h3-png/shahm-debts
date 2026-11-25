// The owner's alert for a worker's entry comes once: live while the app is open, and not again for entries recorded while
// the app was closed (those already went out as phone notifications) when the app opens and the server's answer arrives.
const { chromium } = await import(process.env.PW);
const U="http://127.0.0.1:5075/";let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const F="http://127.0.0.1:8080",DOCS=`${F}/v1/projects/shahm-demo/databases/(default)/documents`;
const val=v=>typeof v==="number"?{integerValue:String(v)}:{stringValue:String(v)};
const fl=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,val(v)]));
const god=(p,o)=>fetch(`${DOCS}/${p}`,{method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:fl(o)})});
const act=(id,amount)=>god("activity/"+id,{id,at:Date.now(),kind:"add",what:"debt",by:"سامي",byRole:"editor",customerName:"أحمد علي",customerId:"c1",amount});
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
const ctx=await b.newContext({viewport:{width:390,height:844},locale:"ar-IQ",serviceWorkers:"block"});
await ctx.addInitScript(()=>{window.__t=[];new MutationObserver(m=>{for(const r of m)for(const n of r.addedNodes)if(n.classList&&n.classList.contains("toast"))window.__t.push(n.textContent)}).observe(document,{childList:true,subtree:true})});
const seen=(p,amt)=>p.evaluate(a=>window.__t.filter(x=>x.includes(a)).length,amt);
let p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(6000);
await act("n1",11111);await p.waitForTimeout(3000);
ok(await seen(p,"11,111")===1,"live entry while open: one alert");
await p.waitForTimeout(1500);ok(await seen(p,"11,111")===1,"…and it does not repeat");
await p.close();
await act("n2",22222);await new Promise(r=>setTimeout(r,1500));
p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
await p.goto(U);await p.waitForTimeout(8000);
ok(await p.evaluate(()=>!document.querySelector("#app").hidden),"reopened, logged in");
ok(await seen(p,"22,222")===0,"entry recorded while closed: no second alert on opening");
ok(await seen(p,"11,111")===0,"older entry: no alert on opening");
await act("n3",33333);await p.waitForTimeout(3000);
ok(await seen(p,"33,333")===1,"next live entry after reopening: one alert");
await b.close();
console.log(bad?`${bad} failed`:"all ok");process.exit(bad?1:0);
