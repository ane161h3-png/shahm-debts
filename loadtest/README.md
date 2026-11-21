# اختبار التحمل (3000 مستخدم بنفس الوقت)

**على staging بس.** السكربتات ترفض السيرفر الحقيقي ومفتاح Firebase الحقيقي، لأن الاختبار يصرف حصة Firestore اليومية ويوقف المحل الحقيقي لباچر.

## شنو يسوي
`k6-shahm.js` يقسّم 3000 مستخدم على أهم الـ endpoints الحقيقية:

| المجموعة | العدد | شنو يسوي | المسار |
|---|---|---|---|
| تصفح | 1800 | يفتح الدفتر كامل، وبعدها يسحب التغييرات كل 10-20 ثانية | `GET /db/pull` |
| حفظ («الطلب») | 900 | يسجّل دين أو تسديد كل 15-30 ثانية | `POST /db/push` |
| تحديث مباشر («الموقع») | 300 | يبقى مربوط على الرابط المباشر بين الأجهزة | WebSocket `/db/live` |
| تسجيل دخول | 5 بالثانية | يسجّل دخول بحساب تجربة | Firebase Auth |

يصعد 3 دقايق، يثبت 10 دقايق، ينزل دقيقة. ينجح إذا: أخطاء أقل من 1%، و95% من القراءة أسرع من 0.8 ثانية، و95% من الحفظ أسرع من ثانية.

## التشغيل من GitHub (الأسهل)
1. جهّز staging مرة وحدة (MAINTENANCE.md، «بيئة التجربة»)، وافتح `https://staging.shahm-debts.pages.dev` وسجّل `admin` بكلمة سر.
2. ضيف GitHub Secrets: `STAGING_OWNER_EMAIL` = `admin@shahm-debts.app`، و`STAGING_OWNER_PASSWORD` = كلمة سر admin بـ staging.
3. Actions ← **Load test** ← Run workflow. `scale` = 0.1 أول مرة (300 مستخدم)، وبعدها 1 (3000). النتيجة تطلع بآخر الصفحة (Summary).

## التشغيل من الكمبيوتر
```bash
# 1) حسابات التجربة (50 محرر + زبون تجربة) → loadtest/accounts.json
FB_KEY=<مفتاح staging> FB_PROJECT=<مشروع staging> OWNER_EMAIL=admin@shahm-debts.app OWNER_PASSWORD=<...> \
WORKER=https://shahm-ai-staging.hydrzyd83.workers.dev N=50 node loadtest/make-accounts.mjs
# 2) فحص سريع بدون k6 (100 مستخدم)
BASE=https://shahm-ai-staging.hydrzyd83.workers.dev FB_KEY=<...> USERS=100 node loadtest/smoke.mjs
# 3) الاختبار الكامل (يحتاج k6: https://k6.io)
k6 run -e BASE=https://shahm-ai-staging.hydrzyd83.workers.dev -e FB_KEY=<...> -e ACCOUNTS=./accounts.json -e SCALE=1 loadtest/k6-shahm.js
```

## قبل ما تشغّله بـ 3000
- **الحصص المجانية:** 15 دقيقة بـ 3000 مستخدم تقريباً 150 ألف طلب على السيرفر، والحد المجاني 100 ألف باليوم. يعني لازم Workers Paid (5$ بالشهر)، أو شغّله بـ `SCALE=0.3`.
- **D1:** كل حفظة تكتب 3-4 صفوف. الحد المجاني 100 ألف صف مكتوب باليوم.
- **Firestore (مشروع staging):** السيرفر يقرا صلاحية كل حساب كل 5 دقايق. 50 ألف قراءة باليوم تكفي لـ 50 حساب.
- **دفتر واحد = Durable Object واحد.** إذا كل الناس على دفتر واحد فهذا أسوأ حالة. حط `TENANTS=main,<uid محل تجربة>` حتى يتوزعون.
- بعد الاختبار ينبقى بدفتر staging حركات «load-test». احذفها أو امسح `shahm-db-staging`. الحقيقي ما ينمس.

## فحص محلي (بدون أي حساب)
`smoke.mjs` جرّبته على نسخة محلية (المحاكي + السيرفر المحلي) بـ 200 مستخدم بنفس الوقت: 200/200 قراءة وحفظ ورابط مباشر بدون أخطاء. هذا يثبت إن الطلبات صحيحة، والأرقام الحقيقية تطلع من staging.
