const { chromium } = await import(process.env.PW);
const U="http://127.0.0.1:5075/";let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
for(const [w,h,tag] of [[390,844,"phone"],[1280,800,"laptop"]]){
const ctx=await b.newContext({viewport:{width:w,height:h},locale:"ar-IQ",serviceWorkers:"block",deviceScaleFactor:2});
const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(5000);
if(await p.locator(".sum-hero .masked").count()){await p.click(".sum-hero .eye");await p.waitForTimeout(500)}
const n=await p.locator(".top-cards .tc:not([aria-hidden])").count();ok(n>=2,tag+": cards shown ("+n+")");
const names=await p.$$eval(".top-cards .tc:not([aria-hidden]) .tc-amt .num",e=>e.map(x=>+x.textContent.replace(/\D/g,"")));
ok(names.every((v,i)=>!i||names[i-1]>=v),tag+": highest first "+names.join(","));
await p.mouse.move(5,5);const x1=await p.$eval(".tc-track .tc",e=>e.getBoundingClientRect().x);await p.waitForTimeout(1500);const x2=await p.$eval(".tc-track .tc",e=>e.getBoundingClientRect().x);
ok(x2>x1,tag+`: strip drifts to the right (${x1.toFixed(0)} → ${x2.toFixed(0)})`);
const sw=await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);ok(sw,tag+": no sideways page scroll");
await p.screenshot({path:`tc-${tag}.png`});
if(tag==="phone"){const id=await p.getAttribute(".tc-track .tc","data-open");await p.$eval(".tc-track .tc",e=>e.click());await p.waitForTimeout(1200);
  ok((await p.textContent(".detail h2"))!=null,"tapping a card opens the account ("+id+")");}
await ctx.close()}
// reduced motion
const ctx=await b.newContext({viewport:{width:390,height:844},reducedMotion:"reduce",serviceWorkers:"block"});const p=await ctx.newPage();
await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(5000);
const x1=await p.$eval(".tc-track .tc",e=>e.getBoundingClientRect().x);await p.waitForTimeout(1200);const x2=await p.$eval(".tc-track .tc",e=>e.getBoundingClientRect().x);
ok(x1===x2&&(await p.locator(".tc:visible").count())===2,"reduce motion: still, no duplicate cards");
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
