// The accounts list keeps its place: picking an account, sending a reminder and live refreshes don't send it back to the top
// (laptop: the list's own scroll; phone: the page scroll, back from the account). Also the «الزبائن حسب الرصيد» strip on
// home scrolls by hand, keeps where it was left, then drifts on.
const { chromium } = await import(process.env.PW);
const U="http://127.0.0.1:5075/",A="http://127.0.0.1:9099",F="http://127.0.0.1:8080",W="http://127.0.0.1:5077",DOCS=`${F}/v1/projects/shahm-demo/databases/(default)/documents`;
let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
// 70 more customers who owe the most (top of the default «الأعلى ديناً» order), in Firestore and the local D1
const tok=(await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"admin@shahm-debts.app",password:"123456",returnSecureToken:true})})).json()).idToken;
const val=v=>typeof v==="number"?{integerValue:String(v)}:{stringValue:String(v)},fl=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,val(v)]));
const god=(p,o)=>fetch(`${DOCS}/${p}`,{method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:fl(o)})});
const now=Date.now(),day=new Date().toISOString().slice(0,10),ops=[];
for(let i=0;i<70;i++){const c={id:"s"+i,name:"زبون تجربة "+(i+1),phone:"0771"+String(1000000+i),createdAt:now-2e6},t={id:"ts"+i,customerId:c.id,type:"debt",amount:9000000-i*1000,date:day,createdAt:now-1e6,by:"المدير"};
  await god("customers/"+c.id,c);await god("txns/"+t.id,t);ops.push(["customers",c.id,c],["txns",t.id,t])}
console.log("push",(await fetch(`${W}/db/push?tenant=main`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+tok},body:JSON.stringify({ops})})).status);
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
const login=async p=>{await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(6000)};
// laptop
{const ctx=await b.newContext({viewport:{width:1280,height:800},locale:"ar-IQ",serviceWorkers:"block"});const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
  ctx.on("page",x=>x.close().catch(()=>{}));await login(p);
  await p.locator('[data-go="customers"]:visible').first().click();await p.waitForTimeout(1200);
  const n=await p.locator("#list .cust-row").count();ok(n>=70,"laptop: list has "+n+" accounts");
  const row=p.locator('#list [data-open="s49"]');await row.evaluate(e=>e.scrollIntoView({block:"center"}));await p.waitForTimeout(300);
  const st0=await p.$eval("#list",e=>e.scrollTop);ok(st0>500,"laptop: list scrolled down ("+st0+")");
  await row.click();await p.waitForTimeout(1500);
  const st1=await p.$eval("#list",e=>e.scrollTop);ok(Math.abs(st1-st0)<5,`laptop: picking account #50 keeps the list (${st0} → ${st1})`);
  ok(await p.getAttribute('#list [data-open="s49"]',"aria-current")==="true","laptop: account #50 stays selected");
  await p.click('#detail .rem-pair a >> nth=0');await p.waitForTimeout(3000);
  const st2=await p.$eval("#list",e=>e.scrollTop);ok(Math.abs(st2-st0)<5,`laptop: sending a reminder keeps the list (${st2})`);
  ok((await p.textContent("#detail h2")).includes("زبون تجربة 50"),"laptop: same account still open");
  // live refresh: a new debt for someone else arrives
  await god("txns/tlive",{id:"tlive",customerId:"s5",type:"debt",amount:500,date:day,createdAt:Date.now(),by:"المدير"});
  await fetch(`${W}/db/push?tenant=main`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+tok},body:JSON.stringify({ops:[["txns","tlive",{id:"tlive",customerId:"s5",type:"debt",amount:500,date:day,createdAt:Date.now(),by:"المدير"}]]})});
  await p.waitForTimeout(4000);const st3=await p.$eval("#list",e=>e.scrollTop);ok(Math.abs(st3-st0)<5,`laptop: live refresh keeps the list (${st3})`);
  await p.screenshot({path:"sc-laptop.png"});
  // a new filter starts from the top
  await p.click('[data-f="owe"]');await p.waitForTimeout(500);await p.click('[data-kind="customer"]');await p.waitForTimeout(800);
  // home strip: hand scroll stays, then drifts on
  await p.locator('[data-go="home"]:visible').first().click();await p.waitForTimeout(1500);
  const v=p.locator(".tc-view");await v.scrollIntoViewIfNeeded();
  const g=()=>p.$eval(".tc-view",e=>Math.abs(e.scrollLeft));const a0=await g();
  const bx=await v.boundingBox();await p.mouse.move(bx.x+bx.width/2-200,bx.y+bx.height/2);await p.mouse.down();await p.mouse.move(bx.x+bx.width/2+200,bx.y+bx.height/2,{steps:10});await p.mouse.up();
  const a1=await g();ok(a1-a0>150,`laptop: mouse drag scrolls the strip (${a0.toFixed(0)} → ${a1.toFixed(0)})`);
  await p.mouse.move(5,5);await p.waitForTimeout(1500);const a2=await g();ok(Math.abs(a2-a1)<3,"laptop: strip rests where it was left ("+a2.toFixed(0)+")");
  await p.waitForTimeout(3000);const a3=await g();ok(a3>a2+10,"laptop: then drifts on ("+a3.toFixed(0)+")");
  ok(await p.locator(".detail h2").count()===0,"laptop: the drag did not open an account");
  await ctx.close()}
// phone
{const ctx=await b.newContext({viewport:{width:390,height:844},locale:"ar-IQ",serviceWorkers:"block",isMobile:true,hasTouch:true,deviceScaleFactor:2});const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
  ctx.on("page",x=>x.close().catch(()=>{}));await login(p);
  // strip on home scrolls by finger (native scroll) and keeps its place through a refresh
  const v=p.locator(".tc-view");await v.scrollIntoViewIfNeeded();
  const ov=await p.$eval(".tc-view",e=>getComputedStyle(e).overflowX);ok(ov==="auto","phone: strip is a scroll box ("+ov+")");
  await p.$eval(".tc-view",e=>{e.scrollLeft-=600});await p.waitForTimeout(800);const s0=await p.$eval(".tc-view",e=>Math.abs(e.scrollLeft));ok(s0>550,"phone: strip moved by hand ("+s0+")");
  await p.screenshot({path:"sc-strip-phone.png"});
  await p.locator('[data-go="customers"]:visible').first().click();await p.waitForTimeout(1200);
  const row=p.locator('#list [data-open="s49"]');await row.evaluate(e=>e.scrollIntoView({block:"center"}));await p.waitForTimeout(300);
  const y0=await p.evaluate(()=>scrollY);ok(y0>1000,"phone: page scrolled to #50 ("+y0+")");
  await row.click();await p.waitForTimeout(1500);ok((await p.textContent("#detail h2")).includes("زبون تجربة 50"),"phone: account #50 open");
  await p.locator('#detail .rem-pair a').first().click();await p.waitForTimeout(2500);
  ok((await p.textContent("#detail h2")).includes("زبون تجربة 50"),"phone: still on #50 after the reminder");
  await p.click('[data-act="back"]');await p.waitForTimeout(800);
  const y1=await p.evaluate(()=>scrollY);ok(Math.abs(y1-y0)<5,`phone: back lands on the same place (${y0} → ${y1})`);
  const vis=await row.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>0&&r.bottom<innerHeight});ok(vis,"phone: #50 is on screen");
  await p.screenshot({path:"sc-phone.png"});
  await ctx.close()}
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
