// Fresh emulators + local D1: admin, 3 customers in both, one only in D1, one only in Firestore. Prints the admin token.
const A="http://127.0.0.1:9099",F="http://127.0.0.1:8080",W="http://127.0.0.1:5077",DOCS=`${F}/v1/projects/shahm-demo/databases/(default)/documents`;
await fetch(`${F}/emulator/v1/projects/shahm-demo/databases/(default)/documents`,{method:"DELETE"});
await fetch(`${A}/emulator/v1/projects/shahm-demo/accounts`,{method:"DELETE"});
const auth=async(path,e,pw)=>(await (await fetch(`${A}/identitytoolkit.googleapis.com/v1/accounts:${path}?key=k`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,password:pw,returnSecureToken:true})})).json());
const val=v=>typeof v==="number"?{integerValue:String(v)}:typeof v==="boolean"?{booleanValue:v}:{stringValue:String(v)};
const fl=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,val(v)]));
const god=(p,o)=>fetch(`${DOCS}/${p}`,{method:"PATCH",headers:{Authorization:"Bearer owner","Content-Type":"application/json"},body:JSON.stringify({fields:fl(o)})});
const adm=await auth("signUp","admin@shahm-debts.app","123456");
await god("settings/main",{shopName:"ماركت الشهم",ownerName:"المدير"});
await god("meta/rules-v3",{at:1});
const now=Date.now(),day=new Date().toISOString().slice(0,10);
const cs=[["c1","أحمد علي"],["c2","حسين كريم"],["c3","علي جاسم"]].map(([id,name],i)=>({id,name,phone:"0770000000"+i,createdAt:now-1e6}));
const ts=[{id:"t1",customerId:"c1",type:"debt",amount:15000,date:day,createdAt:now-9e5,by:"المدير"},{id:"t2",customerId:"c1",type:"pay",amount:5000,date:day,createdAt:now-8e5,by:"المدير"},{id:"t3",customerId:"c2",type:"debt",amount:7000,date:day,createdAt:now-7e5,by:"المدير"}];
for(const c of cs)await god("customers/"+c.id,c);for(const t of ts)await god("txns/"+t.id,t);
await god("customers/cfs",{id:"cfs",name:"زبون فايربيس فقط",createdAt:now});
const ops=[...cs.map(c=>["customers",c.id,c]),...ts.map(t=>["txns",t.id,t]),["customers","cd1",{id:"cd1",name:"زبون دي ون فقط",createdAt:now}]];
const r=await fetch(`${W}/db/push?tenant=main`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+adm.idToken},body:JSON.stringify({ops})});
console.log("push",r.status,await r.text());
