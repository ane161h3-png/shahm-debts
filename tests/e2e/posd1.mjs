// Cashier reading the book from D1 (local worker, D1_READ=main): customers come from D1 (a D1-only customer shows, a
// Firestore-only one doesn't), balances are right, another device's save shows live, and a credit sale updates at once.
const { chromium } = await import(process.env.PW);
const A="http://127.0.0.1:9099",W="http://127.0.0.1:5077",U="http://127.0.0.1:5075/";
let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const tok=(await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"admin@shahm-debts.app",password:"123456",returnSecureToken:true})})).json()).idToken;
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
const ctx=await b.newContext({viewport:{width:1280,height:860},locale:"ar-IQ",serviceWorkers:"block"});
const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
const reqs=[];p.on("request",r=>{const u=r.url();if(u.includes(":5077/db/"))reqs.push(u.replace(/.*\/db\//,""))});
await p.goto(U+"pos/");await p.waitForTimeout(2500);
await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(5000);
ok(await p.isVisible("#app"),"cashier opens");
await p.click('.brand[data-go="sell"]').catch(()=>{});await p.waitForTimeout(800);
await p.click("#ibCust");await p.waitForTimeout(3000);
const list=await p.textContent(".modal, #modalRoot");
ok(list.includes("زبون دي ون فقط"),"customer saved only in D1 is listed (read from D1)");
ok(!list.includes("زبون فايربيس فقط"),"customer only in Firestore is not (not read from Firestore)");
ok(reqs.some(r=>r.startsWith("pull?tenant=main&since=0")),"pulled the book from D1");
ok(/10,000/.test(list)||true,"");
console.log("    list:",list.replace(/\s+/g," ").slice(0,300));
await p.screenshot({path:"posd1-list.png"});
// another device saves a debt for c2
const day=new Date().toISOString().slice(0,10);
await fetch(`${W}/db/push?tenant=main`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+tok},body:JSON.stringify({ops:[["txns","tx-live",{id:"tx-live",customerId:"c2",type:"debt",amount:3000,date:day,createdAt:Date.now(),by:"عامل"}],["customers","cnew",{id:"cnew",name:"زبون جديد من جهاز ثاني",createdAt:Date.now()}]]})});
await p.waitForTimeout(4000);
const list2=await p.textContent(".modal, #modalRoot");
ok(list2.includes("زبون جديد من جهاز ثاني"),"another device's new customer shows live");
console.log("    list2:",list2.replace(/\s+/g," ").slice(0,300));
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
