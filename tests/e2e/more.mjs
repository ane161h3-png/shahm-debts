// Long lists: 450 extra customers → table and list show 200, «عرض المزيد» adds 200, search still finds row 449; balances right.
const A="http://127.0.0.1:9099",W="http://127.0.0.1:5077";
const { chromium } = await import(process.env.PW);
let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const tok=(await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"admin@shahm-debts.app",password:"123456",returnSecureToken:true})})).json()).idToken;
const now=Date.now(),day=new Date().toISOString().slice(0,10),ops=[];
for(let i=0;i<450;i++){ops.push(["customers","m"+i,{id:"m"+i,name:"زبون رقم "+i,createdAt:now-1e6}]);ops.push(["txns","mt"+i,{id:"mt"+i,customerId:"m"+i,type:"debt",amount:1000*(i+1),date:day,createdAt:now-5e5,by:"المدير"}])}
for(let i=0;i<ops.length;i+=400){const r=await fetch(`${W}/db/push?tenant=main`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+tok},body:JSON.stringify({ops:ops.slice(i,i+400)})});if(!r.ok)console.log("push",r.status)}
const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
const p=await (await b.newContext({viewport:{width:1280,height:900},locale:"ar-IQ",serviceWorkers:"block"})).newPage();
p.on("pageerror",x=>{bad++;console.log("PAGEERR",x.message)});
await p.goto("http://127.0.0.1:5075/");await p.waitForTimeout(2000);await p.fill("#lUser","admin");await p.fill("#lPw","123456");await p.click("#lGo");await p.waitForTimeout(6000);
await p.evaluate(()=>{try{localStorage.setItem("shahm-reveal-for","300")}catch(e){}});
const rows=()=>p.locator(".ct-table tbody tr").count();
ok(await rows()===200,"table: first 200 rows ("+await rows()+")");
const footN=Number((await p.textContent(".ct-sum span b")).replace(/[^\d]/g,""));ok(footN>=454,"footer counts every customer, not the 200 shown ("+footN+")");
await p.click('[data-more="ht"]');await p.waitForTimeout(400);ok(await rows()===400,"table: 400 after «عرض المزيد»");
await p.click('[data-more="ht"]');await p.waitForTimeout(400);const all=await rows();ok(all===footN&&await p.locator('[data-more="ht"]').count()===0,"table: all rows, no button ("+all+")");
const top=await p.textContent(".ct-table tbody tr:first-child .ct-nm");ok(top.includes("زبون رقم 449"),"sorted by balance: top is 449 ("+top.trim()+")");
await p.fill("#htq","رقم 3");await p.waitForTimeout(600);ok(await rows()<=200&&await rows()>0,"search resets to the first page ("+await rows()+")");
await p.fill("#htq","زبون رقم 449");await p.waitForTimeout(600);ok((await p.textContent(".ct-table tbody")).includes("450,000"),"row 449 balance 450,000");
await p.locator('.bottom-nav [data-go="customers"], [data-go="customers"]').first().click();await p.waitForTimeout(1200);
const li=await p.locator("#list .cust-row").count();ok(li===200,"side list: 200 rows ("+li+")");
await p.click('#list [data-more="list"]');await p.waitForTimeout(400);ok(await p.locator("#list .cust-row").count()===400,"side list: 400 after more");
await p.click('#list .cust-row [data-open="m449"]').catch(()=>{});
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
