# نسخ المحلات (برنامج الديون للبيع)

كل محل يشتري البرنامج ياخذ نسخة من دفتر الديون (بدون الكاشير) باسم محله وأيقونته، وبياناته على مشروع Firebase بحساب Gmail مالته.
الموقع ينبني وينرفع تلقائياً (`.github/workflows/shops.yml`) على `https://debts-<slug>.pages.dev`، والتطبيق على `/dl/<slug>.apk`.
كل تحديث على `web/` يوصل لكل المحلات بنفس الدفعة.

## 1. مشروع Firebase للمحل (بحساب Gmail مال المشتري، ~15 دقيقة)

1. https://console.firebase.google.com ← **Create a project** ← اسم مثل `alnoor-debts` ← بدون Google Analytics.
2. **Build ← Authentication ← Get started ← Email/Password ← Enable ← Save**.
3. **Build ← Firestore Database ← Create database** ← Location: `eur3 (europe-west)` ← **Start in production mode**.
4. **Firestore ← Rules**: الصق محتوى `firestore.rules` من هذا المستودع كامل ← **Publish**.
5. **Project settings (⚙) ← General ← Your apps ← Web (</>)** ← اسم `debts` ← **Register app**، وانسخ `firebaseConfig`.
6. **Authentication ← Settings ← Authorized domains ← Add domain**: `debts-<slug>.pages.dev`.

## 2. ملف المحل

- انسخ `shops/_example.json` إلى `shops/<slug>.json` (slug: حروف إنجليزية صغيرة وأرقام، يبدي بحرف)، واملأ الاسم والحرف وإعدادات Firebase.
- الأيقونة: `node scripts/shop-icon.mjs <slug> <الحرف>` يرسم `shops/<slug>/icon.png`، أو حط شعار المحل (PNG مربع 1024).
- تجربة محلية: `node scripts/build-shop.mjs shops/<slug>.json /tmp/shop`.
- PR ← دمج ← الموقع والتطبيق ينبنون (أول مرة ~10 دقايق).

## 3. أول دخول

افتح `https://debts-<slug>.pages.dev` ← **إنشاء حساب** باسم المستخدم `admin` ← هذا الحساب يصير المدير.
بعدها من **الإعدادات ← حسابي** يربط بريده الحقيقي حتى يكدر يسترجع كلمة المرور.

## ملاحظات

- قراءة صور الدفتر (`aiUrl`) مو مفعلة للنسخ بعد: تحتاج Worker خاص بالمحل ومفتاح Gemini باسمه.
- النسخ الاحتياطي على تليغرام خاص بالشهم، مو للنسخ. المشتري ياخذ نسخته من **الإعدادات ← النسخ الاحتياطي**.
- `scripts/build-shop.mjs` يفشل إذا بقى اسم «الشهم» بالصفحة، فإذا غيّرت نصوص فيها اسم المحل بـ `web/index.html` حدّث السكربت.
