// Home board (cards at the top of home) + month-start lock. Adds late / month-locked customers to the seed, then checks
// the today card, the late and locked cards and their reels, auto and manual moves, swipe, the setting, the lock gate.
const { chromium } = await import(process.env.PW);
const U="http://127.0.0.1:5075/";let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const A="http://127.0.0.1:9099",F="http://127.0.0.1:8080",W="http://127.0.0.1:5077",DOCS=`${F}/v1/projects/shahm-demo/databases/(default)/documents`;
const val=v=>typeof v==="number"?{integerValue:String(v)}:typeof v==="boolean"?{booleanValue:v}:{stringValue:String(v)};
const fl=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,val(v)]));
const god=(p,o,mask)=>fetch(`${DOCS}/${p}${mask?"?"+mask.map(k=>"updateMask.fieldPaths="+k).join("&"):""}`,{method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:fl(o)})});
const adm=await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"admin@shahm-debts.app",password:"123456",returnSecureToken:true})})).json();
const now=Date.now(),iso=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const ago=n=>iso(new Date(now-n*864e5)),today=iso(new Date()),lastMonth=iso(new Date(new Date().getFullYear(),new Date().getMonth()-1,20));
const cs=[["c4","سعد ناصر"],["c5","مهدي كاظم"],["c6","باسم حميد"],["c7","كرار عباس"],["c8","زيد فاضل"],["c9","عمار حسن"]].map(([id,name],i)=>({id,name,phone:"0771000000"+i,createdAt:now-5e9}));
const ts=[
  {id:"h1",customerId:"c4",type:"debt",amount:25000,date:ago(40),createdAt:now-40*864e5},
  {id:"h2",customerId:"c5",type:"debt",amount:12000,date:ago(50),createdAt:now-50*864e5},
  {id:"h3",customerId:"c6",type:"debt",amount:30000,date:lastMonth,createdAt:now-35*864e5},
  {id:"h4",customerId:"c7",type:"debt",amount:10000,date:lastMonth,createdAt:now-35*864e5},
  {id:"h5",customerId:"c7",type:"pay",amount:10000,date:today,createdAt:now-6e5},
  {id:"h6",customerId:"c8",type:"debt",amount:10000,date:lastMonth,createdAt:now-35*864e5},
  {id:"h7",customerId:"c8",type:"pay",amount:4000,date:today,createdAt:now-5e5},
  {id:"h8",customerId:"c8",type:"debt",amount:20000,date:today,createdAt:now-4e5},
  {id:"h9",customerId:"c9",type:"debt",amount:9000,date:today,createdAt:now-3e5}].map(t=>({...t,by:"المدير"}));
for(const c of cs)await god("customers/"+c.id,c);for(const t of ts)await god("txns/"+t.id,t);
await god("settings/main",{lockMonth:1},["lockMonth"]);
const r=await fetch(`${W}/db/push?tenant=main`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+adm.idToken},body:JSON.stringify({ops:[...cs.map(c=>["customers",c.id,c]),...ts.map(t=>["txns",t.id,t])]})});
console.log("    push",r.status);

// The cashier uses its own copy of the rule: run it on the same records.
{const fs=await import("node:fs"),vm=await import("node:vm");const src=fs.readFileSync(new URL("../../web/pos/index.html",import.meta.url),"utf8");
  const code=src.slice(src.indexOf("const monthLock=()=>"),src.indexOf("// Whether a record came after"));
  const S={settings:{lockMonth:1}},cx={S,isSup:c=>c&&c.kind==="supplier",todayISO:()=>today};vm.createContext(cx);vm.runInContext(code+";this.f=monthLockOf",cx);
  const rows=id=>ts.filter(t=>t.customerId===id);
  ok(["c4","c5","c6","c8"].every(id=>cx.f({id},rows(id)))&&!cx.f({id:"c7"},rows("c7"))&&!cx.f({id:"c9"},rows("c9")),"cashier: same customers locked (c4 c5 c6 c8, not c7 c9)");
  ok(cx.f({id:"c8"},rows("c8")).owe===6000,"cashier: c8 still owes 6,000 of last month");
  ok(!cx.f({id:"c8",lockDays:0},rows("c8"))&&!cx.f({id:"c8",lockReset:today},rows("c8")),"cashier: «بدون قفل» and opened this month are not locked");
  S.settings.lockMonth=0;ok(!cx.f({id:"c4"},rows("c4")),"cashier: off = nobody")}

const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
for(const [w,h,tag,dark] of [[390,844,"phone",false],[1280,800,"laptop",false],[820,1180,"ipad",false],[390,844,"phone-dark",true]]){
const ctx=await b.newContext({viewport:{width:w,height:h},locale:"ar-IQ",serviceWorkers:"block",deviceScaleFactor:2,colorScheme:dark?"dark":"light",...(w<500?{isMobile:true,hasTouch:true}:{})});
const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(6000);
await p.evaluate(()=>{try{localStorage.setItem("shahm-reveal-for","600")}catch(e){}});
if(await p.locator(".sum-hero .masked").count()){await p.click(".sum-hero .eye");await p.waitForTimeout(500)}
await p.mouse.move(2,2);
const top2=await p.$$eval("#view > div > *",e=>e.slice(0,2).map(x=>x.id||x.className));ok(/home-search/.test(top2[0])&&top2[1]==="hb",tag+": search first, then the board ("+top2+")");
const kinds=await p.$$eval("#hb .hb-card",e=>e.map(x=>x.className.match(/k-(\w+)/)[1]));ok(kinds.join()==="today,late,lock",tag+": cards "+kinds.join());
if(tag==="phone"){
  const st=await p.$$eval("#hb .k-today .hb-st .v",e=>e.map(x=>x.textContent.replace(/[^\d]/g,"")));
  // Earlier tests (more.mjs) add many debts today straight to the database, so check at least this test's own records.
  ok(+st[0]>=4&&+st[1]>=51000&&+st[2]>=19000,`today: debts / amount / payments ${st.join(" / ")} (at least 4 / 51000 / 19000)`);
  const late=await p.$$eval("#hb .k-late .hb-ri b",e=>e.map(x=>x.textContent));ok(late.length===3&&late[0]==="مهدي كاظم"&&late.includes("باسم حميد"),"late reel: "+late.join("، "));
  const lk=await p.$$eval("#hb .k-lock .hb-ri b",e=>e.map(x=>x.textContent)).catch(()=>[]);ok(lk.length===4&&lk.includes("زيد فاضل")&&!lk.includes("كرار عباس")&&!lk.includes("عمار حسن"),"locked reel: "+lk.join("، "));
  ok((await p.textContent('#hb .k-lock .hb-ri[data-open="c8"]')).includes("حساب الشهر"),"locked reel says why (last month)");
}
await p.screenshot({path:`hb-${tag}.png`});
if(w>=768){
  // laptop / iPad: every card side by side, no sliding, the reels still turn
  const boxes=await p.$$eval("#hb .hb-card",e=>e.map(x=>{const r=x.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width)]}));
  ok(boxes.length===3&&boxes.every(b=>b[1]===boxes[0][1]&&b[0]>=0&&b[0]+b[2]<=w),tag+": all 3 cards side by side and on screen "+JSON.stringify(boxes));
  ok(boxes[0][0]>boxes[1][0]&&boxes[1][0]>boxes[2][0],tag+": today first from the right");
  ok(!(await p.locator("#hb .hb-bar").count())&&!(await p.locator("#hb [inert]").count()),tag+": no dots or arrows, nothing hidden");
  const rp=k=>p.textContent(`#hb [data-hbreel="${k}"] [data-hbpos]`);const a1=[await rp("late"),await rp("lock")];await p.waitForTimeout(3600);const a2=[await rp("late"),await rp("lock")];
  ok(a1[0]!==a2[0]&&a1[1]!==a2[1],tag+`: both reels turn by themselves (${a1} → ${a2})`);
  const x0=boxes[0][0];await p.waitForTimeout(5000);ok(await p.$eval("#hb .hb-card",e=>Math.round(e.getBoundingClientRect().x))===x0,tag+": cards stay put");
  ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),tag+": no sideways page scroll");
  await p.locator("#hb").screenshot({path:`card-${tag}-all.png`});
  await ctx.close();continue}
const idx=()=>p.$eval("#hb .hb-dots [aria-current=true]",e=>[...e.parentNode.children].indexOf(e));
ok(await idx()===0,tag+": starts on today");
await p.waitForTimeout(9000);ok(await idx()===1,tag+": moved on by itself to late");
const pos=()=>p.textContent('#hb [data-hbreel="late"] [data-hbpos]');await p.click("#hb [data-hbgo='1']");await p.mouse.move(2,2);await p.waitForTimeout(300);const p1=await pos();const seen=[p1];for(let i=0;i<8;i++){await p.waitForTimeout(500);seen.push(await pos()+"@"+await idx())}console.log("    reel",seen.join(" "));const p2=await pos();
ok(p1!==p2,tag+`: late reel moves by itself (${p1} → ${p2})`);
await p.screenshot({path:`hb-${tag}-late.png`});
if(tag!=="phone-dark"){
  await p.click('#hb [data-hbreel="late"] [data-hbr="1"]');await p.waitForTimeout(600);const p3=await pos();ok(p3!==p2,tag+`: reel arrow (${p2} → ${p3})`);
  await p.mouse.move(2,2);await p.click("#hb [data-hbs='1']");await p.waitForTimeout(700);ok(await idx()===2,tag+": arrow to locked card");
  await p.screenshot({path:`hb-${tag}-lock.png`});
  await p.click("#hb [data-hbgo='0']");await p.waitForTimeout(700);ok(await idx()===0,tag+": dot back to today");
  // swipe: dragging right brings the next card
  const bx=await p.$eval("#hb .hb-view",e=>{window.scrollTo(0,0);const r=e.getBoundingClientRect();return [r.x,r.y,r.width]});
  await p.mouse.move(bx[0]+bx[2]*0.3,bx[1]+40);await p.mouse.down();for(let i=1;i<=8;i++)await p.mouse.move(bx[0]+bx[2]*0.3+i*20,bx[1]+42);await p.mouse.up();await p.waitForTimeout(800);
  let si=await idx();if(si!==1){console.log("    swipe missed once, again");await p.click("#hb [data-hbgo='0']");await p.waitForTimeout(700);
    await p.mouse.move(bx[0]+bx[2]*0.3,bx[1]+40);await p.mouse.down();for(let i=1;i<=8;i++)await p.mouse.move(bx[0]+bx[2]*0.3+i*20,bx[1]+42);await p.mouse.up();await p.waitForTimeout(800);si=await idx()}
ok(si===1,tag+": swipe right → next card ("+si+")");
  ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),tag+": no sideways page scroll");
  // live refresh keeps the position
  await p.locator('[data-go="customers"]:visible').first().click();await p.waitForTimeout(500);await p.locator('[data-go="home"]:visible').first().click();await p.waitForTimeout(500);
  const ri=await idx();ok(ri===si,tag+": a redraw keeps the card ("+ri+")");
}
for(const [i,k] of [[0,"today"],[1,"late"],[2,"lock"]]){await p.click(`#hb [data-hbgo='${i}']`);await p.mouse.move(2,2);await p.waitForTimeout(700);await p.locator("#hb").screenshot({path:`card-${tag}-${k}.png`})}
if(tag==="phone"){
  // tap a name in the locked reel opens the account; month chip and banner; a debt opens the lock window
  await p.click("#hb [data-hbgo='2']");await p.waitForTimeout(700);
  for(let i=0;i<5&&await p.getAttribute('#hb [data-hbreel="lock"] .hb-ri:not([tabindex])',"data-open")!=="c8";i++){await p.click('#hb [data-hbreel="lock"] [data-hbr="1"]');await p.waitForTimeout(550)}
  await p.click('#hb [data-hbreel="lock"] .hb-ri[data-open="c8"]');await p.waitForTimeout(1500);
  ok((await p.textContent(".balance-card")).includes("مقفول: حساب الشهر"),"c8 page: chip «مقفول: حساب الشهر»");
  const bn=await p.textContent(".banner.bad.promise-row");ok(bn.includes("الشهر الماضي")&&bn.includes("6,000"),"c8 page: banner says 6,000 of last month");
  await p.screenshot({path:"hb-c8.png"});
  await p.click('[data-act="debt"]');await p.waitForTimeout(800);
  const mt=await p.textContent(".modal");ok(mt.includes("مقفول")&&mt.includes("لآخر هذا الشهر"),"debt → lock window (open lasts the month)");
  await p.screenshot({path:"hb-gate.png"});
  await p.click("#lkOpen");await p.waitForTimeout(1500);await p.keyboard.press("Escape");await p.waitForTimeout(300);
  ok(await p.locator(".banner.bad.promise-row").count()===0,"opened: no lock banner");
  await p.locator('.bottom-nav [data-go="home"]').click();await p.waitForTimeout(1200);
  const lk2=await p.$$eval("#hb .k-lock .hb-ri b",e=>e.map(x=>x.textContent));ok(lk2.length===3&&!lk2.includes("زيد فاضل"),"locked card drops c8 after opening");
  // settings
  await p.locator('.bottom-nav [data-go="settings"]').click();await p.waitForTimeout(800);await p.click('[data-setacc="lock"]');await p.waitForTimeout(1200);
  ok(await p.getAttribute('[data-lockmonth="1"]',"aria-pressed")==="true","settings: «يوم 1» on");
  await p.locator('[data-lockmonth="1"]').scrollIntoViewIfNeeded();await p.screenshot({path:"hb-settings.png"});
  await p.click('[data-lockmonth="0"]');await p.waitForTimeout(1500);ok(await p.getAttribute('[data-lockmonth="0"]',"aria-pressed")==="true","settings: turned off");
  await p.locator('.bottom-nav [data-go="home"]').click();await p.waitForTimeout(1200);
  ok(!(await p.locator("#hb .k-lock").count()),"off: locked card gone (nobody locked)");
  await p.locator('.bottom-nav [data-go="settings"]').click();await p.waitForTimeout(800);if(!(await p.locator('[data-lockmonth="1"]').count())){await p.click('[data-setacc="lock"]');await p.waitForTimeout(1000)}
  await p.click('[data-lockmonth="1"]');await p.waitForTimeout(800);if(await p.locator(".modal").count()){await p.screenshot({path:"hb-confirm.png"});await p.click("#okBtn");await p.waitForTimeout(1500)}
  ok(await p.getAttribute('[data-lockmonth="1"]',"aria-pressed")==="true","settings: back on");
}
await ctx.close()}
// reduced motion: still works (moves without the slide animation)
{const ctx=await b.newContext({viewport:{width:390,height:844},reducedMotion:"reduce",serviceWorkers:"block"});const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
await p.goto(U);await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(6000);
ok(await p.locator("#hb .hb-card").count()>=2,"reduce motion: board shows");await ctx.close()}
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
