// Month-end notice button on the customer's own page: opens WhatsApp with that customer's month-end message, logs a reminder.
const { chromium } = await import(process.env.PW);
const U="http://127.0.0.1:5075/";let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
for(const [w,h,tag] of [[390,844,"phone"],[1280,800,"laptop"]]){
  const ctx=await b.newContext({viewport:{width:w,height:h},locale:"ar-IQ",serviceWorkers:"block",isMobile:w<500,hasTouch:w<500,deviceScaleFactor:2});
  const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
  const pops=[];ctx.on("page",x=>{pops.push(x.url());x.close().catch(()=>{})});
  await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(5000);
  await p.locator('[data-go="customers"]:visible').first().click();await p.waitForTimeout(1000);
  await p.fill("#q","أحمد علي");await p.waitForTimeout(600);await p.click('.cust-row [data-open="c1"]');await p.waitForTimeout(1500);
  const me=p.locator('#detail .rem-pair a',{hasText:"تبليغ نهاية الشهر"});
  ok(await me.count()===1,tag+": month-end button on customer page");
  const href=decodeURIComponent(await me.getAttribute("href")||"");
  ok(href.includes("أحمد علي")&&href.includes("قبل نهاية الشهر")&&/\d,\d{3}/.test(href),tag+": message has name, amount and month-end text");
  ok(await p.locator('#detail .rem-pair a',{hasText:"إرسال تذكير بالدين"}).count()===1,tag+": balance reminder still there");
  await me.evaluate(e=>e.scrollIntoView({block:"center"}));await p.waitForTimeout(400);await p.screenshot({path:"me-"+tag+".png"});
  if(tag==="phone"){
    await me.click();await p.waitForTimeout(1500);
    ok(pops.length===1,"opens WhatsApp in a new tab");
    const dd=new Date(),inWin=new Date(dd.getFullYear(),dd.getMonth()+1,0).getDate()-dd.getDate()<5;
    ok(!inWin||await p.locator("#detail .ro-note",{hasText:"وصله تذكير"}).count()===1,"logged: «✓ وصله تذكير» under the buttons");await p.evaluate(()=>scrollBy(0,-120));await p.screenshot({path:"me-sent.png"});
    // c2 owes nothing extra but has a debt; c3 owes nothing: no buttons
    await p.click('[data-act="back"]').catch(()=>{});await p.waitForTimeout(800);
    await p.fill("#q","علي جاسم");await p.waitForTimeout(600);await p.click('.cust-row [data-open="c3"]');await p.waitForTimeout(1200);
    ok(await p.locator('#detail .rem-pair').count()===0,"no buttons for a customer who owes nothing");
  }
  await ctx.close();
}
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
