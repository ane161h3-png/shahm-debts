/* Support chat (الدعم الفني) between this app's owner and a shop's owner, shared by the debt book (index.html), the
   cashier (pos/) and the owner's panel (admin/). The messages live in Cloudflare D1 behind the worker (worker/src/support.js),
   so a chat costs no Firestore reads; a WebSocket brings each new message and "read" mark straight away.
   Colors come from the page's own brand tokens (BRAND.md), so this file adds none. */
(function(){
"use strict";
let cfg=null; // {base, token: () => Promise<string>, side: "shop" | "admin", push: bool}
const $=(r,s)=>r.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeImg=u=>typeof u==="string"&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(u)?u:"";
const base=()=>cfg.base.replace(/\/$/,"");
const hm=ms=>new Date(ms).toLocaleTimeString("ar-IQ",{hour:"numeric",minute:"2-digit",numberingSystem:"latn"});
const dayKey=ms=>{const d=new Date(ms);return d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate()};
const dayLbl=ms=>{const k=dayKey(ms),t=Date.now();if(k===dayKey(t))return "اليوم";if(k===dayKey(t-864e5))return "البارحة";
  return new Date(ms).toLocaleDateString("ar-IQ",{weekday:"long",day:"numeric",month:"long",numberingSystem:"latn"})};
const linkify=t=>esc(t).replace(/https?:\/\/[^\s<]+/g,u=>`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`).replace(/\n/g,"<br>");

async function api(path,opt={}){
  const tok=await cfg.token();
  const r=await fetch(base()+"/support/"+path,{method:opt.body?"POST":"GET",headers:{Authorization:"Bearer "+tok,...(opt.body?{"Content-Type":"application/json"}:{})},body:opt.body?JSON.stringify(opt.body):undefined});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(j.error||"تعذّر الاتصال بالدعم الفني.");e.status=r.status;throw e}
  return j;
}
// A live link to one conversation (or "*", every conversation, for the owner), reconnecting by itself until closed.
function liveLink(shop,onEv){
  let ws=null,closed=false,tries=0,ping=null;
  const go=async()=>{if(closed)return;let tok;try{tok=await cfg.token()}catch(e){return retry()}
    try{ws=new WebSocket(base().replace(/^http/,"ws")+"/support/live?shop="+encodeURIComponent(shop),["bearer",tok])}catch(e){return retry()}
    ws.onopen=()=>{tries=0;onEv({t:"open"});clearInterval(ping);ping=setInterval(()=>{try{ws.send("ping")}catch(e){}},30000)};
    ws.onmessage=m=>{if(m.data==="pong")return;try{onEv(JSON.parse(m.data))}catch(e){}};
    ws.onclose=()=>{clearInterval(ping);retry()};ws.onerror=()=>{}};
  const retry=()=>{if(closed)return;tries++;setTimeout(go,Math.min(30000,1000*2**Math.min(tries,5)))};
  go();
  return ()=>{closed=true;clearInterval(ping);try{ws&&ws.close()}catch(e){}};
}
// A photo shrunk for the chat: ~1280px, JPEG stepped down until it is under ~300 KB of text.
async function shrink(file){
  let src;
  try{src=await createImageBitmap(file,{imageOrientation:"from-image"})}
  catch(e){src=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error("bad"));i.src=URL.createObjectURL(file)})}
  const k=Math.min(1,1280/Math.max(src.width,src.height)),cv=document.createElement("canvas");
  cv.width=Math.round(src.width*k);cv.height=Math.round(src.height*k);cv.getContext("2d").drawImage(src,0,0,cv.width,cv.height);
  let u=cv.toDataURL("image/jpeg",.8);for(let q=.7;u.length>300000&&q>.25;q-=.1)u=cv.toDataURL("image/jpeg",q);
  if(u.length>390000){const c2=document.createElement("canvas");c2.width=Math.round(cv.width*.6);c2.height=Math.round(cv.height*.6);c2.getContext("2d").drawImage(cv,0,0,c2.width,c2.height);u=c2.toDataURL("image/jpeg",.6)}
  return u;
}

/* Phone notifications for the chat: this device's Web Push subscription (the page's own service worker) is stored on the
   server for this side of the chat, so a reply reaches the phone with the app closed. */
const PUSH_KEY="shahm-sup-push";
const pushOk=()=>"serviceWorker" in navigator&&"PushManager" in window&&"Notification" in window&&!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
const pushIsOn=()=>{try{return Notification.permission==="granted"&&!!localStorage.getItem(PUSH_KEY)}catch(e){return false}};
async function pushOn(quiet){
  if(!pushOk())throw new Error("هذا الجهاز ما يدعم الإشعارات. افتح الموقع من Chrome.");
  if(!quiet&&await Notification.requestPermission()!=="granted")throw new Error("لازم تسمح بالإشعارات حتى توصلك.");
  if(Notification.permission!=="granted")return false;
  const {key}=await (await fetch(base()+"/push")).json();if(!key)throw new Error("الإشعارات بعدها ما مفعّلة على السيرفر.");
  const reg=await navigator.serviceWorker.ready;
  const app=Uint8Array.from(atob(key.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((key.length+3)%4)),c=>c.charCodeAt(0));
  let sub=await reg.pushManager.getSubscription();
  if(sub&&sub.options&&sub.options.applicationServerKey&&btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)))!==btoa(String.fromCharCode(...app))){await sub.unsubscribe();sub=null}
  sub=sub||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:app});
  const j=sub.toJSON();await api("sub",{body:{e:j.endpoint,p:j.keys.p256dh,a:j.keys.auth}});
  try{localStorage.setItem(PUSH_KEY,j.endpoint.slice(-24))}catch(e){}
  return true;
}
async function pushOff(){
  try{const reg=await navigator.serviceWorker.ready,sub=await reg.pushManager.getSubscription();if(sub)await api("sub",{body:{off:true,e:sub.endpoint}})}catch(e){}
  try{localStorage.removeItem(PUSH_KEY)}catch(e){}
}

let styled=false;
function css(){if(styled)return;styled=true;const s=document.createElement("style");s.textContent=`
.sup-ov{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.42);display:flex;align-items:stretch;justify-content:center;animation:supFade .18s ease}
@keyframes supFade{from{opacity:0}}@keyframes supUp{from{transform:translateY(14px);opacity:0}}
.sup-box{background:var(--bg);width:100%;max-width:720px;display:flex;flex-direction:column;min-height:0;box-shadow:var(--shadow);animation:supUp .22s ease}
@media (min-width:760px){.sup-ov{padding:24px}.sup-box{border-radius:var(--r-modal,18px);overflow:hidden;border:1px solid var(--line)}}
.sup-h{display:flex;align-items:center;gap:10px;padding:10px 12px;padding-top:max(10px,env(safe-area-inset-top));background:var(--accent);color:var(--accent-ink)}
.sup-h .sup-t{flex:1;min-width:0}.sup-h b{display:block;font-family:var(--f-display);font-size:17px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sup-h small{display:block;font-size:12.5px;opacity:.85}
.sup-ib{border:0;background:transparent;color:inherit;min-width:40px;height:40px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;font:700 14px var(--f-display);padding:0 8px}
.sup-ib:hover{background:rgba(255,255,255,.12)}.sup-ib svg{width:22px;height:22px;flex:none}.sup-ib.pill svg{width:18px;height:18px}
.sup-ib.pill{border:1px solid currentColor;height:34px;border-radius:99px;padding:0 12px;white-space:nowrap}
.sup-list{flex:1;overflow-y:auto;padding:14px 12px 8px;display:flex;flex-direction:column;gap:6px;overscroll-behavior:contain}
.sup-more{align-self:center;margin-bottom:6px}
.sup-day{align-self:center;font-size:12px;color:var(--muted);background:var(--paper-2);border:1px solid var(--line);border-radius:99px;padding:2px 10px;margin:8px 0 4px}
.sup-m{max-width:min(78%,480px);padding:8px 11px 6px;border-radius:14px;line-height:1.6;font-size:15px;overflow-wrap:anywhere;box-shadow:0 1px 1px rgba(0,0,0,.05)}
.sup-m.me{align-self:flex-start;background:var(--accent);color:var(--accent-ink);border-end-start-radius:4px}
.sup-m.me a{color:inherit}
.sup-m.them{align-self:flex-end;background:var(--paper);border:1px solid var(--line);color:var(--ink);border-end-end-radius:4px}
.sup-m .sup-ft{display:flex;white-space:nowrap;gap:6px;align-items:center;justify-content:flex-end;font-size:11.5px;opacity:.8;margin-top:2px;direction:ltr}
.sup-m .sup-tk{font-weight:700;letter-spacing:-3px;padding-inline-end:3px}.sup-m .sup-tk.rd{color:var(--brand-leaf,currentColor)}
.sup-m img{display:block;max-width:100%;max-height:300px;border-radius:10px;margin:2px 0 4px;cursor:zoom-in;background:var(--paper-2)}
.sup-m .sup-ph{width:220px;height:140px;border-radius:10px;background:var(--paper-2);display:grid;place-items:center;color:var(--muted);font-size:13px;margin:2px 0 4px}
.sup-empty{margin:auto;text-align:center;color:var(--muted);max-width:340px;padding:20px;line-height:1.8}
.sup-empty b{display:block;color:var(--ink);font-family:var(--f-display);font-size:18px;margin-bottom:4px}
.sup-note{margin:0 12px 8px;padding:8px 12px;border-radius:10px;font-size:13.5px;background:var(--paid-soft);color:var(--paid);text-align:center}
.sup-note.open{background:var(--warn-soft);color:var(--warn)}
.sup-f{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;padding-bottom:max(10px,env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--paper)}
.sup-f textarea{flex:1;min-height:44px;max-height:140px;resize:none;border:1px solid var(--line);border-radius:22px;padding:10px 14px;font:15px/1.5 var(--f-body);background:var(--paper-2);color:var(--ink)}
.sup-f textarea:focus{outline:2px solid var(--accent);outline-offset:0;border-color:transparent}
.sup-f .rb{width:44px;height:44px;flex:none;border-radius:50%;border:1px solid var(--line);background:var(--paper-2);color:var(--accent);display:grid;place-items:center;cursor:pointer}
.sup-f .rb.go{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.sup-f .rb:disabled{opacity:.5;cursor:default}
.sup-f .rb svg{width:22px;height:22px}
.sup-pv{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--paper);border-top:1px solid var(--line);font-size:13.5px;color:var(--muted)}
.sup-pv img{width:54px;height:54px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.sup-err{color:var(--debt);font-size:13.5px;padding:0 14px 6px;background:var(--paper)}
.sup-zoom{position:fixed;inset:0;z-index:95;background:rgba(0,0,0,.85);display:grid;place-items:center;cursor:zoom-out}
.sup-zoom img{max-width:96vw;max-height:92vh;border-radius:8px}
.sup-off{font-size:12.5px;text-align:center;color:var(--muted);padding:4px}
@media (prefers-reduced-motion:reduce){.sup-ov,.sup-box{animation:none}}
`;document.head.appendChild(s)}

const IC={back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  img:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 8"/></svg>',
  send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4 18-7z"/></svg>',
  bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>'};

const imgCache=new Map();
let cur=null; // the open conversation

// Opens the chat with one shop (the owner) or with the owner (a shop: shop = its own id).
function open(shop,o={}){
  css();if(cur)close();
  const me=cfg.side,them=me==="admin"?"shop":"admin";
  const st={shop,msgs:new Map(),thread:null,more:false,img:null,sending:false,stopLive:null,sinceOpen:false};cur=st;
  const ov=document.createElement("div");ov.className="sup-ov";ov.setAttribute("role","dialog");ov.setAttribute("aria-modal","true");ov.setAttribute("aria-label",o.title||"الدعم الفني");
  ov.innerHTML=`<div class="sup-box">
    <div class="sup-h"><button type="button" class="sup-ib" data-x aria-label="رجوع">${IC.back}</button><div class="sup-t"><b>${esc(o.title||"الدعم الفني")}</b><small class="sup-sub">${esc(o.sub||"")}</small></div><span class="sup-acts"></span></div>
    <div class="sup-list" aria-live="polite"><div class="sup-empty">جاري التحميل…</div></div>
    <div class="sup-note-slot"></div>
    <div class="sup-pv-slot"></div><div class="sup-err" role="alert"></div>
    <form class="sup-f" novalidate><button type="button" class="rb" data-pick aria-label="إرفاق صورة">${IC.img}</button>
      <textarea rows="1" maxlength="2000" placeholder="${me==="shop"?"اكتب مشكلتك أو سؤالك…":"اكتب ردّك…"}" aria-label="الرسالة"></textarea>
      <button type="submit" class="rb go" aria-label="إرسال">${IC.send}</button>
      <input type="file" accept="image/*" hidden></form></div>`;
  document.body.appendChild(ov);st.ov=ov;
  const list=$(ov,".sup-list"),ta=$(ov,"textarea"),form=$(ov,"form"),file=$(ov,"input[type=file]"),err=$(ov,".sup-err");
  const prevFocus=document.activeElement;st.onClose=()=>{try{prevFocus&&prevFocus.focus&&prevFocus.focus()}catch(e){}o.onClose&&o.onClose()};
  $(ov,"[data-x]").onclick=close;
  ov.addEventListener("click",e=>{if(e.target===ov)close()});
  ov.addEventListener("keydown",e=>{if(e.key==="Escape"){e.stopPropagation();close()}});
  const grow=()=>{ta.style.height="auto";ta.style.height=Math.min(140,ta.scrollHeight)+"px"};
  ta.addEventListener("input",grow);
  ta.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!matchMedia("(pointer:coarse)").matches){e.preventDefault();form.requestSubmit()}});
  $(ov,"[data-pick]").onclick=()=>file.click();
  file.onchange=async()=>{const f=file.files[0];file.value="";if(!f)return;err.textContent="";
    try{st.img=await shrink(f);drawPv()}catch(e){err.textContent="ما گدرت أقرا الصورة. جرّب صورة ثانية."}};
  const drawPv=()=>{$(ov,".sup-pv-slot").innerHTML=st.img?`<div class="sup-pv"><img src="${safeImg(st.img)}" alt=""><span>صورة مرفقة (${Math.round(st.img.length*.75/1024)} KB)</span><button type="button" class="sup-ib" data-rm style="color:var(--debt);margin-inline-start:auto">إزالة</button></div>`:"";
    const rm=$(ov,"[data-rm]");if(rm)rm.onclick=()=>{st.img=null;drawPv()}};
  form.onsubmit=async e=>{e.preventDefault();if(st.sending)return;const text=ta.value.trim();if(!text&&!st.img){ta.focus();return}
    st.sending=true;const sb=$(ov,".rb.go");sb.disabled=true;err.textContent="";
    try{const j=await api("send",{body:{shop:me==="admin"?shop:undefined,text,img:st.img||undefined}});
      if(st.img&&j.msg)imgCache.set(shop+"|"+j.msg.id,st.img);
      ta.value="";st.img=null;drawPv();grow();add(j.msg);st.thread=j.thread;draw(true);o.onThread&&o.onThread(j.thread)}
    catch(x){err.textContent=x.message}
    finally{st.sending=false;sb.disabled=false;ta.focus()}};

  const add=m=>{if(m&&m.id)st.msgs.set(m.id,m)};
  const readMark=()=>{if(!st.thread||cur!==st||document.visibilityState!=="visible")return;
    const unread=me==="admin"?st.thread.ua:st.thread.us;if(unread>0||st.thread.n&&(me==="admin"?st.thread.ra:st.thread.rs)<Math.max(0,...st.msgs.keys()))
      api("read",{body:{shop:me==="admin"?shop:undefined}}).then(j=>{st.thread=j.thread;o.onThread&&o.onThread(j.thread);drawNote()}).catch(()=>{})};
  st.readMark=readMark;
  const drawNote=()=>{const t=st.thread,ns=$(ov,".sup-note-slot"),acts=$(ov,".sup-acts"),sub=$(ov,".sup-sub");
    if(me==="admin"){acts.innerHTML=`<button type="button" class="sup-ib pill" data-solve>${t&&t.status==="solved"?"إعادة فتح":"✓ تم الحل"}</button>`;
      $(acts,"[data-solve]").onclick=()=>{const to=t&&t.status==="solved"?"open":"solved";
        api("status",{body:{shop,status:to}}).then(j=>{st.thread=j.thread;drawNote();o.onThread&&o.onThread(j.thread)},x=>err.textContent=x.message)};
      sub.textContent=(o.sub?o.sub+" · ":"")+(t&&t.status==="solved"?"محلولة":"مفتوحة")}
    else{const can=cfg.push&&pushOk();acts.innerHTML=can&&!pushIsOn()?`<button type="button" class="sup-ib pill" data-bell>${IC.bell} نبّهني بالرد</button>`:"";
      const b=$(acts,"[data-bell]");if(b)b.onclick=()=>pushOn(false).then(()=>{drawNote();toast("✓ يوصلك إشعار لما نرد")},x=>err.textContent=x.message);
      sub.textContent="المحادثة ويا صاحب البرنامج"}
    ns.innerHTML=t&&t.n?(t.status==="solved"?`<div class="sup-note">✓ ${me==="admin"?"معلّمة «تم الحل». إذا كتب صاحب المحل تنفتح وحدها.":"انحلّت المشكلة. إذا عندك شي ثاني اكتب، والمحادثة تنفتح من جديد."}</div>`
      :me==="shop"&&t.last_from==="shop"?`<div class="sup-note open">وصلت رسالتك. نرد عليك بأقرب وقت.</div>`:""):""};
  const draw=(toEnd)=>{
    const near=toEnd||list.scrollHeight-list.scrollTop-list.clientHeight<120,prevH=list.scrollHeight,prevTop=list.scrollTop;
    const ms=[...st.msgs.values()].sort((a,b)=>a.id-b.id),readUp=st.thread?(me==="admin"?st.thread.rs:st.thread.ra):0;
    if(!ms.length){list.innerHTML=`<div class="sup-empty"><b>${me==="shop"?"كيف نگدر نساعدك؟":"ما بيها رسائل بعد"}</b>${me==="shop"?"اكتب المشكلة بالتفصيل، وإذا تگدر ارفق صورة للشاشة. الرد يوصلك هنا.":"تگدر تبدي أنت المحادثة."}</div>`;drawNote();return}
    let h=st.more?`<button type="button" class="btn sm sup-more" data-more>رسائل أقدم</button>`:"",last="";
    for(const m of ms){const dk=dayKey(m.at);if(dk!==last){h+=`<div class="sup-day">${esc(dayLbl(m.at))}</div>`;last=dk}
      const mine=m.side===me,key=shop+"|"+m.id,iu=m.img?imgCache.get(key):"";
      h+=`<div class="sup-m ${mine?"me":"them"}">${m.img?(iu?`<img src="${safeImg(iu)}" alt="صورة" data-zoom="${m.id}">`:`<div class="sup-ph" data-img="${m.id}">📷 جاري تحميل الصورة…</div>`):""}${m.text?`<div>${linkify(m.text)}</div>`:""}
        <div class="sup-ft"><span>${hm(m.at)}</span>${mine?`<span class="sup-tk ${m.id<=readUp?"rd":""}" title="${m.id<=readUp?"تمت القراءة":"وصلت"}" aria-label="${m.id<=readUp?"تمت القراءة":"وصلت"}">${m.id<=readUp?"✓✓":"✓"}</span>`:""}</div></div>`}
    list.innerHTML=h;
    if(near)list.scrollTop=list.scrollHeight;else if(st.older){list.scrollTop=list.scrollHeight-prevH+prevTop;st.older=false}
    list.querySelectorAll("[data-img]").forEach(ph=>loadImg(Number(ph.dataset.img)));
    list.querySelectorAll("[data-zoom]").forEach(im=>im.onclick=()=>zoom(im.src));
    const mb=$(list,"[data-more]");if(mb)mb.onclick=()=>more();
    drawNote()};
  st.draw=draw;
  const loadImg=id=>{const key=shop+"|"+id;if(imgCache.has(key)||loadImg[key])return;loadImg[key]=1;
    api("img?shop="+encodeURIComponent(shop)+"&id="+id).then(j=>{const u=safeImg(j.img);if(u){imgCache.set(key,u);if(cur===st)draw()}}).catch(()=>{}).finally(()=>{delete loadImg[key]})};
  const more=()=>{const first=Math.min(...st.msgs.keys());st.older=true;
    api("msgs?shop="+encodeURIComponent(shop)+"&before="+first).then(j=>{j.msgs.forEach(add);st.more=j.more;draw()}).catch(x=>err.textContent=x.message)};
  const load=()=>api("msgs?shop="+encodeURIComponent(shop)).then(j=>{if(cur!==st)return;j.msgs.forEach(add);st.more=j.more;st.thread=j.thread;draw(true);o.onThread&&o.onThread(j.thread);readMark()})
    .catch(x=>{if(cur!==st)return;list.innerHTML=`<div class="sup-empty"><b>ما گدرنا نفتح المحادثة</b>${esc(x.message)}</div>`});
  load();
  st.stopLive=liveLink(shop,ev=>{if(cur!==st)return;
    if(ev.t==="open"){if(st.sinceOpen)load();st.sinceOpen=true;return}
    if(ev.shop!==shop)return;if(ev.msg)add(ev.msg);if(ev.thread)st.thread=ev.thread;draw(ev.msg&&ev.msg.side===me);o.onThread&&ev.thread&&o.onThread(ev.thread);
    if(ev.msg&&ev.msg.side===them)readMark()});
  st.vis=()=>{if(document.visibilityState==="visible")readMark()};document.addEventListener("visibilitychange",st.vis);
  // Signed in as a shop with notifications already allowed: keep this device's subscription stored without asking.
  if(me==="shop"&&cfg.push&&pushOk()&&Notification.permission==="granted")pushOn(true).then(()=>drawNote()).catch(()=>{});
  setTimeout(()=>{if(!matchMedia("(pointer:coarse)").matches)ta.focus()},60);
  return st;
}
function close(){const st=cur;if(!st)return;cur=null;st.stopLive&&st.stopLive();document.removeEventListener("visibilitychange",st.vis);st.ov.remove();st.onClose&&st.onClose()}
function zoom(src){const z=document.createElement("div");z.className="sup-zoom";z.innerHTML=`<img src="${safeImg(src)}" alt="">`;z.onclick=()=>z.remove();document.body.appendChild(z)}
function toast(t){if(typeof window.toast==="function")return window.toast(t);const d=document.createElement("div");d.textContent=t;d.style.cssText="position:fixed;bottom:24px;inset-inline:0;margin:auto;width:max-content;max-width:90vw;background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:12px;z-index:99;font:600 14px var(--f-display)";document.body.appendChild(d);setTimeout(()=>d.remove(),3000)}

window.ShahmSupport={
  init(o){cfg=o;css()},
  ready:()=>!!(cfg&&cfg.base),
  open,close,isOpen:()=>!!cur,
  me:()=>api("me"),threads:()=>api("threads"),
  liveAll:onEv=>liveLink("*",onEv),
  pushOn,pushOff,pushIsOn,pushOk,shrink,
};
})();
