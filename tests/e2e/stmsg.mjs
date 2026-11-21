// New-debt WhatsApp message carries the account's statement link.
const { chromium } = await import(process.env.PW);
const A="http://127.0.0.1:9099",F="http://127.0.0.1:8080",W="http://127.0.0.1:5077",U="http://127.0.0.1:5075/",DOCS=`${F}/v1/projects/shahm-demo/databases/(default)/documents`;
let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const tok=(await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"admin@shahm-debts.app",password:"123456",returnSecureToken:true})})).json()).idToken;
const CID="cm"+Date.now(),dy=new Date().toISOString().slice(0,10);
const cust={id:CID,name:"كريم حسن",phone:"07701234567",createdAt:Date.now()};
await fetch(`${W}/db/push?tenant=main`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+tok},body:JSON.stringify({ops:[["customers",CID,cust],["txns",CID+"a",{id:CID+"a",customerId:CID,type:"debt",amount:4000,date:dy,createdAt:Date.now()-5000,by:"المدير"}]]})});
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
const ctx=await b.newContext({viewport:{width:390,height:800},locale:"ar-IQ",serviceWorkers:"block",isMobile:true,hasTouch:true});
const p=await ctx.newPage();p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
await p.addInitScript(()=>{window.__open=[];window.open=u=>{window.__open.push(u);return {}}});
await p.goto(U);await p.waitForTimeout(2500);
await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(6000);
await p.locator('[data-go="customers"]:visible').first().click();await p.waitForTimeout(1500);
await p.click(`[data-open="${CID}"]`);await p.waitForTimeout(2500);
const k=await p.evaluate(id=>{try{return JSON.parse(localStorage.getItem("shahm-st:main")||"{}")[id]||""}catch(e){return ""}},CID);
ok(/^[A-Za-z0-9_-]{22}$/.test(k),"opening the account fetched its link onto the device");
await p.click('[data-act="debt"]');await p.waitForTimeout(800);
await p.fill("#tAmt","3000");await p.evaluate(()=>document.querySelector("#tf").requestSubmit());await p.waitForTimeout(2500);
const opened=await p.evaluate(()=>window.__open.slice());const msg=decodeURIComponent((opened[0]||"").split("text=")[1]||"");
console.log("    msg:",msg.replace(/\n/g," | "));
ok(msg.includes("تم تسجيل دين جديد")&&msg.includes("كشف حسابك: ")&&msg.includes("s.html#"+k),"new-debt message ends with the account's link");
const g=await (await fetch(`${W}/st?k=${k}`)).json();ok(g.bal===7000,"the link shows the new balance (7,000): "+g.bal);
// payment message: no link
await p.click('[data-act="pay"]');await p.waitForTimeout(800);
await p.fill("#tAmt","1000");await p.evaluate(()=>{const x=document.querySelector("#tPdf");if(x)x.checked=false;document.querySelector("#tf").requestSubmit()});await p.waitForTimeout(2500);
const o2=await p.evaluate(()=>window.__open.slice());const m2=decodeURIComponent((o2[1]||"").split("text=")[1]||"");
ok(m2.includes("استلمنا")&&!m2.includes("كشف حسابك"),"payment message unchanged");
// «رابط جديد» on this device → next debt message carries the new link
await p.click('[data-act="stlink"]');await p.waitForTimeout(2500);p.on("dialog",d=>d.accept());await p.click("#stNew");await p.waitForTimeout(2500);
const k2=(await p.inputValue("#stUrl")).split("#")[1];await p.click("[data-close]");
await p.click('[data-act="debt"]');await p.waitForTimeout(800);await p.fill("#tAmt","500");await p.evaluate(()=>document.querySelector("#tf").requestSubmit());await p.waitForTimeout(2500);
const o3=await p.evaluate(()=>window.__open.slice());const m3=decodeURIComponent((o3[o3.length-1]||"").split("text=")[1]||"");
ok(k2!==k&&m3.includes("#"+k2),"after «رابط جديد» the message carries the new link");
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
