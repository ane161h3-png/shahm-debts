# دفتر ديون ماركت الشهم

برنامج ديون الزبائن والموردين: كشوف حساب PDF، تذكير واتساب، نسخ احتياطي، وعدة مستخدمين بصلاحيات.
يشتغل على اللابتوب والموبايل، وبدون إنترنت، والبيانات تتزامن بين كل الأجهزة.

## التحميل
- **أندرويد (APK):** https://github.com/ane161h3-png/shahm-debts/releases/latest/download/shahm-debts.apk
- **لابتوب / آيفون:** https://ane161h3-png.github.io/shahm-debts/ ثم «تثبيت» من المتصفح.

## كيف مبني
- `web/` البرنامج نفسه (صفحة واحدة) + PWA (`manifest.webmanifest`, `sw.js`) للتثبيت والعمل بدون إنترنت.
- Firebase: تسجيل الدخول (Email/Password) وقاعدة البيانات Firestore مع حفظ محلي. القواعد في `firestore.rules`.
  المدير هو اسم المستخدم `admin`؛ باقي الحسابات تنتظر تفعيله من الإعدادات > المستخدمين.
- `web/config.js` مفاتيح مشروع Firebase (عامة بطبيعتها؛ الحماية من القواعد وتسجيل الدخول).
- Android عبر Capacitor: `.github/workflows/android.yml` يبني APK مع كل تحديث وينشره في Releases.
- `.github/workflows/pages.yml` ينشر `web/` على GitHub Pages.

## تحديث المكتبات
`npm install && npm run vendor` ينسخ Firebase وjsPDF والخطوط إلى `web/vendor` حتى يشتغل البرنامج بدون CDN.

## نسخة احتياطية يومية على تلكرام
`.github/workflows/backup.yml` يشتغل كل يوم الساعة 11 بالليل (بغداد): يدخل بحساب `backup` (مشاهد فقط)،
يقرأ كل البيانات، ويدز ملف النسخة لتلكرام. يحتاج أسرار المستودع: `BACKUP_PASSWORD`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.
الملف ما ينحفظ بالمستودع ولا يطبع بالسجل. إذا فشل يوصلك تنبيه على تلكرام.
