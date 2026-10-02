// Reads a photo of the shop's handwritten daily ledger and returns the entries as transactions,
// matched to existing customers. The app shows them for review before anything is saved.
// Uses Google Gemini (free tier) by default; adding an ANTHROPIC_API_KEY secret switches it to Claude.
import Anthropic from "@anthropic-ai/sdk";

const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 7_000_000; // ~5 MB of base64 per photo
const MAX_CUSTOMERS = 5000;

const SYSTEM = `You read photos of a handwritten daily credit ledger (دفتر يوميات) from a small grocery shop in Iraq and turn every entry into a transaction for the shop's debt book.

How the ledger is written:
- Usually one entry per line: a customer's name, then an amount, sometimes the goods taken. Names are Iraqi Arabic and are often nicknames or family references (ابو علي، ام حسين، حجي كريم، علي الحلاق).
- An entry is a debt (the customer took goods on credit) unless it says the customer paid: words such as واصل، وصل، دفع، سدد، تسديد، استلمت، or a minus sign before the amount. Those are type "pay".
- Lines that are completely crossed out were cancelled: skip them. Skip headings, dates, page totals and sums.
- Amounts are Iraqi dinars. Shopkeepers usually write them in thousands: the smallest banknote is 250, so any amount below 250 is in thousands (5 → 5000, 2.5 or 2,5 → 2500, 7½ → 7500, 0.5 → 500). Amounts like 250, 750, 1500 or 25000 are literal. Digits may be Arabic-Indic (٠١٢٣٤٥٦٧٨٩).

For every entry, in the order it appears on the page:
- written_name: the name exactly as written.
- customer_id: the id of the same person from the customer list. Allow for spelling variants (ة/ه، ى/ي، أ/إ/ا، with or without ال، shortened names, a nickname that clearly matches a listed name). Use "" when nobody in the list is the same person.
- match: "sure" when the match is clear, "unsure" when it is a plausible guess, "none" when customer_id is "".
- type: "debt" or "pay".
- amount: whole dinars after applying the thousands rule.
- amount_unsure: true when the digits are hard to read.
- note: the goods or remark written with the entry (e.g. رز، سكر، كارت), otherwise "".

Never invent entries that are not on the page. If the photo has no ledger entries, return an empty list.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["written_name", "customer_id", "match", "type", "amount", "amount_unsure", "note"],
        properties: {
          written_name: { type: "string" },
          customer_id: { type: "string" },
          match: { type: "string", enum: ["sure", "unsure", "none"] },
          type: { type: "string", enum: ["debt", "pay"] },
          amount: { type: "integer" },
          amount_unsure: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
  },
};

const json = (body, status, cors) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

function corsFor(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" } : { Vary: "Origin" };
}

// Only the owner and active editors may use it (the same people who can add debts in the app).
async function authorize(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: "سجّل دخولك أولاً.", status: 401 };
  const authUrl = env.AUTH_URL || "https://identitytoolkit.googleapis.com";
  const r = await fetch(`${authUrl}/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  const j = await r.json().catch(() => ({}));
  const user = r.ok && j.users && j.users[0];
  if (!user) return { error: "انتهت الجلسة. اطلع وادخل من جديد.", status: 401 };
  if (user.email === env.OWNER_EMAIL) return { user };
  const dbUrl = env.FIRESTORE_URL || "https://firestore.googleapis.com";
  const p = await fetch(`${dbUrl}/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents/users/${user.localId}`, { headers: { Authorization: "Bearer " + token } });
  const d = p.ok ? await p.json() : null;
  const f = (d && d.fields) || {};
  const active = f.status && f.status.stringValue === "active";
  const editor = f.role && f.role.stringValue === "editor";
  if (!active || !editor) return { error: "هذي الخاصية للمدير والمحررين فقط.", status: 403 };
  return { user };
}

function readBody(b) {
  const images = Array.isArray(b && b.images) ? b.images : [];
  if (!images.length) return { error: "ما وصلت صورة." };
  if (images.length > MAX_IMAGES) return { error: `أقصى عدد ${MAX_IMAGES} صور بالمرة الوحدة.` };
  for (const im of images) {
    if (!im || typeof im.data !== "string" || !/^image\/(jpeg|png|webp)$/.test(im.media_type || "")) return { error: "صيغة الصورة غير مدعومة." };
    if (im.data.length > MAX_IMAGE_CHARS) return { error: "الصورة كبيرة جداً." };
  }
  const customers = (Array.isArray(b.customers) ? b.customers : [])
    .filter(c => c && typeof c.id === "string" && typeof c.name === "string")
    .slice(0, MAX_CUSTOMERS)
    .map(c => ({ id: c.id.slice(0, 64), name: c.name.replace(/[\n|]/g, " ").slice(0, 80) }));
  return { images, customers };
}

class UserError extends Error {}

const customerList = input => input.customers.map(c => `${c.id}|${c.name}`).join("\n") || "(no customers yet)";
const ASK = "Read every ledger entry in these photos.";

async function readWithClaude(env, input) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `Customer list (id|name):\n${customerList(input)}` },
        ...input.images.map(im => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
        { type: "text", text: ASK },
      ],
    }],
  });
  if (response.stop_reason === "refusal") return { error: "ما كدر يقرأ الصورة. جرّب صورة ثانية." };
  if (response.stop_reason === "max_tokens") return { error: "الورقة طويلة كلش. صوّرها على قسمين." };
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  try { return { rows: JSON.parse(text).rows }; } catch { throw new UserError("صار خطأ بقراءة النتيجة. حاول مرة ثانية."); }
}

// Gemini's response schema uses the OpenAPI subset: no additionalProperties.
function geminiSchema(x) {
  if (Array.isArray(x)) return x.map(geminiSchema);
  if (!x || typeof x !== "object") return x;
  const o = {};
  for (const [k, v] of Object.entries(x)) if (k !== "additionalProperties") o[k] = geminiSchema(v);
  if (o.properties) o.propertyOrdering = Object.keys(o.properties);
  return o;
}

async function readWithGemini(env, input) {
  const base = env.GEMINI_URL || "https://generativelanguage.googleapis.com";
  const model = env.GEMINI_MODEL || "gemini-flash-latest";
  const r = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{
        role: "user",
        parts: [
          { text: `Customer list (id|name):\n${customerList(input)}` },
          ...input.images.map(im => ({ inline_data: { mime_type: im.media_type, data: im.data } })),
          { text: ASK },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(SCHEMA), temperature: 0 },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const status = (j.error && j.error.status) || "";
    console.error("gemini", r.status, status, j.error && j.error.message);
    if (r.status === 429) throw new UserError("خلص الحد المجاني لهاليوم من Gemini. حاول باچر أو بعد شوية.");
    if (r.status === 400 && /API_KEY_INVALID|API key/i.test(JSON.stringify(j))) throw new UserError("مفتاح Gemini غير صحيح.");
    if (r.status === 403) throw new UserError("مفتاح Gemini ما عنده صلاحية. تأكد إنه مفعّل.");
    if (r.status === 404) throw new UserError("موديل Gemini غير متوفر. لازم يتحدث السيرفر.");
    throw new UserError("تعذّر الاتصال بـ Gemini. حاول مرة ثانية.");
  }
  if (j.promptFeedback && j.promptFeedback.blockReason) return { error: "ما كدر يقرأ الصورة. جرّب صورة ثانية." };
  const cand = (j.candidates || [])[0] || {};
  if (cand.finishReason === "MAX_TOKENS") return { error: "الورقة طويلة كلش. صوّرها على قسمين." };
  const text = ((cand.content && cand.content.parts) || []).filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("");
  try { return { rows: JSON.parse(text).rows }; } catch { throw new UserError("صار خطأ بقراءة النتيجة. حاول مرة ثانية."); }
}

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Not found" }, 404, cors);
    if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) return json({ error: "مفتاح الذكاء الاصطناعي غير مضبوط على السيرفر." }, 500, cors);

    try {
      const auth = await authorize(request, env);
      if (auth.error) return json({ error: auth.error }, auth.status, cors);
      const input = readBody(await request.json().catch(() => null));
      if (input.error) return json({ error: input.error }, 400, cors);

      const useClaude = !!env.ANTHROPIC_API_KEY;
      const out = useClaude ? await readWithClaude(env, input) : await readWithGemini(env, input);
      if (out.error) return json({ error: out.error }, 422, cors);
      let rows = out.rows;

      // Never trust an id the model returned unless it is one of ours.
      const ids = new Set(input.customers.map(c => c.id));
      rows = (Array.isArray(rows) ? rows : []).map(r => {
        const known = ids.has(r.customer_id);
        return {
          written_name: String(r.written_name || "").slice(0, 80),
          customer_id: known ? r.customer_id : "",
          match: known ? (r.match === "sure" ? "sure" : "unsure") : "none",
          type: r.type === "pay" ? "pay" : "debt",
          amount: Math.max(0, Math.round(Number(r.amount) || 0)),
          amount_unsure: !!r.amount_unsure,
          note: String(r.note || "").slice(0, 140),
        };
      });
      console.log(`read ${rows.length} rows for ${auth.user.email} via ${useClaude ? "claude" : "gemini"}`);
      return json({ rows }, 200, cors);
    } catch (e) {
      console.error(e);
      if (e instanceof UserError) return json({ error: e.message }, 502, cors);
      const msg = e instanceof Anthropic.AuthenticationError ? "مفتاح الذكاء الاصطناعي غير صحيح."
        : e instanceof Anthropic.RateLimitError ? "ضغط على الخدمة هسه. انتظر دقيقة وحاول."
        : e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message || "") ? "رصيد حساب الذكاء الاصطناعي خلص. اشحنه من console.anthropic.com."
        : "تعذّر الاتصال بخدمة الذكاء الاصطناعي. حاول مرة ثانية.";
      return json({ error: msg }, 502, cors);
    }
  },
};
