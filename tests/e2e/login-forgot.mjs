// Login with number or e-mail in one field, number still working after linking an e-mail, and «نسيت كلمة المرور» end to end.
const { chromium } = await import(process.env.PW);
const A="http://127.0.0.1:9099",F="http://127.0.0.1:8080",U="http://127.0.0.1:5075/",DOCS=`${F}/v1/projects/shahm-demo/databases/(default)/documents`;
let bad=0;const ok=(c,m)=>{if(!c)bad++;console.log((c?"  ok ":"  XX ")+m)};
const val=v=>typeof v==="number"?{integerValue:String(v)}:typeof v==="boolean"?{booleanValue:v}:{stringValue:String(v)};
const fl=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,val(v)]));
const god=(p,o)=>fetch(`${DOCS}/${p}`,{method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:fl(o)})});
const godGet=async p=>(await fetch(`${DOCS}/${p}`,{headers:{Authorization:"Bearer owner"}})).json();
const sign=async(email,pw="12345678")=>{const b={email,password:pw,returnSecureToken:true};let r=await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();
  if(!r.localId)r=await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();return r};
const oob=async(email,type)=>(await (await fetch(`${A}/emulator/v1/projects/shahm-demo/oobCodes`)).json()).oobCodes.filter(c=>c.email===email&&c.requestType===type).at(-1);
const now=Date.now(),suf=String(now).slice(-6),PH="0772"+suf+"1",MAIL="shop"+suf+"@gmail.com";

const admin=await sign("admin@shahm-debts.app");await god("settings/owner",{uid:admin.localId});
const sh=await sign(MAIL);
await god("shops/"+sh.localId,{id:sh.localId,owner:sh.localId,name:"محل "+suf,ownerName:"علي",phone:PH,username:PH,status:"active",until:now+30*864e5,createdAt:now});
await god("memberOf/"+sh.localId,{shop:sh.localId,at:now});await god(`shops/${sh.localId}/settings/main`,{shopName:"محل "+suf,ownerName:"علي"});
const wk=await sign("wk"+suf+"@shahm-debts.app");

const b=await chromium.launch({executablePath:process.env.CHROME||undefined});
const errs=[];
const fresh=async()=>{const c=await b.newContext({viewport:{width:420,height:860},locale:"ar-IQ",serviceWorkers:"block"});await c.addInitScript(()=>{try{localStorage.setItem("shahm-intro","1")}catch(e){}});const p=await c.newPage();p.on("pageerror",x=>errs.push(x.message));return {c,p}};
const txt=async p=>(await p.textContent("body")).replace(/\s+/g," ");
const login=async(p,user,pw="12345678")=>{await p.waitForSelector("#lUser",{timeout:15000});await p.fill("#lUser",user);await p.fill("#lPw",pw);await p.click("#lGo")};
const inApp=async p=>{try{await p.waitForSelector('[data-go="settings"]',{timeout:15000,state:"attached"});return true}catch(e){await p.screenshot({path:"shots/lg-fail.png"});console.log("   body:",(await txt(p)).slice(0,300));return false}};

console.log("One field");
let {c,p}=await fresh();await p.goto(U);await p.waitForSelector("#lUser");
ok(await p.$("[data-ltab]")===null,"no number/e-mail tabs any more");
ok((await txt(p)).includes("رقم الهاتف أو الإيميل"),"the field asks for a number or an e-mail");
await p.fill("#lUser","a@");ok((await p.innerHTML("#lUserW")).includes("svg"),"the icon follows what is typed");
await login(p,MAIL);ok(await inApp(p),"signs in with the e-mail");await p.waitForTimeout(2500);
const lg=(await godGet("logins/"+PH)).fields;ok(lg&&lg.email.stringValue===MAIL&&lg.uid.stringValue===sh.localId,"its number now points at the e-mail");
await c.close();
({c,p}=await fresh());await p.goto(U);await login(p,PH.replace(/^0/,"+964 "));ok(await inApp(p),"a new device signs in with the number (+964 form)");await c.close();

console.log("Forgot the password");
({c,p}=await fresh());await p.goto(U+"pos/");await p.waitForSelector("#lUser");ok(await p.$('a[href="../#forgot"]')!==null,"the cashier links to «نسيت كلمة المرور»");
await p.goto(U+"admin/");await p.waitForSelector("#lUser");ok(await p.$('a[href="../#forgot"]')!==null,"the owner's panel links to it");
await p.goto(U+"#forgot");await p.waitForSelector("#fMail");ok(true,"#forgot opens the form");
await p.fill("#fMail","wk"+suf);await p.click("#fGo");await p.waitForTimeout(1200);ok((await p.textContent("#fErr")).includes("ما مربوط بإيميل"),"an account without an e-mail is told so");
await p.fill("#fMail",PH);await p.click("#fGo");await p.waitForTimeout(2000);
ok((await txt(p)).includes("وصلك رابط تحقق على sh•••@gmail.com"),"by number: the link goes to the linked e-mail (shown masked)");
const code=await oob(MAIL,"PASSWORD_RESET");ok(!!code,"a reset e-mail was sent");
const q=new URL(code.oobLink).searchParams;
await p.goto(U+"?mode=resetPassword&oobCode="+q.get("oobCode")+"&lang=ar");await p.waitForSelector("#rpPw",{timeout:15000});
ok((await txt(p)).includes(MAIL),"the link opens the new-password form for that account");
await p.fill("#rpPw","123");await p.click("#rpGo");ok((await p.textContent("#rpErr")).includes("أحرف"),"a short password is refused");
await p.fill("#rpPw","newpass123");await p.fill("#rpPw2","newpass12");await p.click("#rpGo");ok((await p.textContent("#rpErr")).includes("مو نفس"),"mismatch is refused");
await p.fill("#rpPw2","newpass123");await p.click("#rpGo");await p.waitForSelector("#lUser",{timeout:15000});
ok((await txt(p)).includes("تغيّرت كلمة المرور"),"saved; back to the sign-in with a message");
ok(!new URL(p.url()).searchParams.get("oobCode"),"the code is gone from the address");
await p.fill("#lUser",PH);await p.fill("#lPw","12345678");await p.click("#lGo");await p.waitForTimeout(2500);ok(await p.$("#lUser")!==null,"the old password no longer works");
await login(p,PH,"newpass123");ok(await inApp(p),"the number signs in with the new password");await c.close();
({c,p}=await fresh());await p.goto(U+"?mode=resetPassword&oobCode="+q.get("oobCode"));await p.waitForTimeout(3000);
ok((await txt(p)).includes("الرابط انتهى"),"the same link cannot be used twice");await c.close();

console.log("E-mail confirmation link");
const nv=await sign("nv"+suf+"@gmail.com");
await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestType:"VERIFY_EMAIL",idToken:nv.idToken})});
const vc=await oob("nv"+suf+"@gmail.com","VERIFY_EMAIL");
({c,p}=await fresh());await p.goto(U+"?mode=verifyEmail&oobCode="+new URL(vc.oobLink).searchParams.get("oobCode"));await p.waitForTimeout(3000);
ok((await txt(p)).includes("تأكد الإيميل"),"a confirmation link opens here and confirms");
const st=await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({idToken:nv.idToken})})).json();
ok(st.users&&st.users[0].emailVerified===true,"the account is marked confirmed");await c.close();

ok(!errs.length,"no page errors "+errs.join(" | "));
await b.close();console.log(bad?"FAIL "+bad:"ALL OK");process.exit(bad?1:0);
