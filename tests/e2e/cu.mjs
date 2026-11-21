const { chromium } = await import(process.env.PW);
const U="http://127.0.0.1:5075/";let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const A=20000+Math.floor(Math.random()*90)*100,P=1000+Math.floor(Math.random()*30)*100;
const num=s=>Number(String(s||"").replace(/[^\d]/g,""));
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
const ctx=await b.newContext({viewport:{width:390,height:844},locale:"ar-IQ",serviceWorkers:"block",isMobile:true,hasTouch:true,deviceScaleFactor:2});
const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});p.on("popup",x=>x.close());
await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(5000);
// unhide everything for this test
await p.evaluate(()=>{try{localStorage.setItem("shahm-reveal-for","300")}catch(e){}});
if(await p.locator(".sum-hero .masked").count()){await p.click(".sum-hero .eye");await p.waitForTimeout(500)}
const t0=num(await p.textContent('.sum-hero [data-cu="total"]'));console.log("    total",t0);
await p.locator('.bottom-nav [data-go="customers"]').click();await p.waitForTimeout(1000);
await p.click('.cust-row [data-open="c1"]');await p.waitForTimeout(1500);
if(await p.locator(".balance-card .masked").count()){await p.click(".balance-card .lbl .eye");await p.waitForTimeout(500)}
const sel='.balance-card [data-cu^="bal:"]';const b0=num(await p.textContent(sel));console.log("    bal",b0);
ok(await p.locator(".cu-badge").count()===0,"first view: no animation");
await p.click('[data-act="debt"]');await p.waitForTimeout(800);
await p.fill("#tAmt",String(A));await p.evaluate(()=>{const w=document.querySelector("#tWa");if(w)w.checked=false;document.querySelector("#tf").requestSubmit()});
const seen=[];for(let i=0;i<20;i++){if(i===5)await p.screenshot({path:"cu-mid.png"});seen.push(num(await p.textContent(sel))+(await p.locator(".cu-badge").count()?"b":""));await p.waitForTimeout(60)}console.log("    seen",seen.join(" "));
const mid=seen.map(x=>parseInt(x)).find(x=>x>b0&&x<b0+A);console.log("    mid",mid);
ok(mid>b0&&mid<b0+A,"number is counting up mid-way ("+mid+")");
ok(await p.locator(".balance-card .cu-badge").count()===1,"+25,000 badge shows");
ok((await p.textContent(".balance-card .cu-badge")).includes(A.toLocaleString("en-US")),"badge says 25,000");

await p.waitForTimeout(1600);
ok(num(await p.textContent(sel))===b0+A,"ends at the exact new balance");
ok(await p.locator(".cu-badge").count()===0,"badge gone");
await p.click('[data-act="pay"]');await p.waitForTimeout(800);
await p.fill("#tAmt",String(P));await p.evaluate(()=>{for(const id of ["#tPdf","#tWa"]){const x=document.querySelector(id);if(x)x.checked=false}document.querySelector("#tf").requestSubmit()});
await p.waitForTimeout(250);
const m2=num(await p.textContent(sel));ok(m2<b0+A&&m2>b0+A-P,"payment counts down ("+m2+")");
ok((await p.getAttribute(".balance-card .cu-badge","class")).includes("cu-paid"),"payment badge is green");
await p.waitForTimeout(1800);ok(num(await p.textContent(sel))===b0+A-P,"ends at balance after payment");
await p.locator('.bottom-nav [data-go="home"]').click();await p.waitForTimeout(150);
ok(await p.locator(".sum-hero .cu-badge").count()===1,"home total animates too");
await p.waitForTimeout(250);await p.screenshot({path:"cu-home.png"});
await p.waitForTimeout(1600);ok(num(await p.textContent('.sum-hero [data-cu="total"]'))===t0+A-P,"home total exact");
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
