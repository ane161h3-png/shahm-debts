// Reads a photo of the shop's handwritten daily ledger and returns the entries as transactions,
// matched to existing customers. The app shows them for review before anything is saved.
// With kind "items" (the cashier app, owner only) it reads a supplier invoice or a list of goods instead and returns the items.
// Uses Google Gemini (free tier) by default; adding an ANTHROPIC_API_KEY secret switches it to Claude.
import Anthropic from "@anthropic-ai/sdk";

const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 7_000_000; // ~5 MB of base64 per photo
const MAX_CUSTOMERS = 5000;
const MAX_PRODUCTS = 5000;
const MAX_ITEMS = 200;

const SYSTEM = `You read photos of a handwritten daily credit ledger (دفتر يوميات) from a small grocery shop in Iraq and turn every entry into a transaction for the shop's debt book.

How the ledger is written:
- Usually one entry per line: a customer's name, then an amount, sometimes the goods taken. Names are Iraqi Arabic and are often nicknames or family references (ابو علي، ام حسين، حجي كريم، علي الحلاق).
- An entry is a debt (the customer took goods on credit) unless it says the customer paid: words such as واصل، وصل، دفع، سدد، تسديد، استلمت، or a minus sign before the amount. Those are type "pay".
- Lines that are completely crossed out were cancelled: skip them. Skip headings, dates, page totals and sums.
- Amounts are Iraqi dinars. Shopkeepers usually write them in thousands: the smallest banknote is 250, so any amount below 250 is in thousands (5 → 5000, 2.5 or 2,5 → 2500, 7½ → 7500, 0.5 → 500). Amounts like 250, 750, 1500 or 25000 are literal. Digits may be Arabic-Indic (٠١٢٣٤٥٦٧٨٩).

The shop may also use its printed form "ماركت الشهم · ورقة اليوميات" (small tag "SHAHM DAILY SHEET v4" in the bottom corner). On that form:
- The page has two tables side by side. Read the right-hand table first (printed rows ت 1–30, top to bottom), then the left-hand table (rows 31–60). Never join a name from one table with an amount from the other.
- Each numbered row is one entry. The current form (v4) has three columns, right to left: ت (printed row number), اسم الزبون (name), المبلغ (amount). Follow each row straight across its printed lines: the name and amount of one entry sit between the same two horizontal lines, next to the same row number. Every fifth line is printed thicker to help you keep count.
- Anything written after the name in the name cell (goods, a remark) goes in note, never into written_name.
- A row is "debt" unless it says the customer paid: a payment word (واصل، وصل، دفع، سدد) or a minus sign written anywhere in the row, usually next to the amount, means "pay".
- Older printouts may have a fourth column المواد (goods) between the name and the amount: put what is written there into note. The oldest have 26 rows per table and a small واصل box after the amount: a tick, cross, dot or scribble inside that box also means "pay".
- Skip empty rows, the printed headings and instructions, the date and sheet number at the top, and any totals.
- A row with a line through it was cancelled: skip it. A single crossed-out amount with a new amount written beside it is a correction: use the new amount.

Reading handwritten digits:
- Arabic-Indic digits: ٠ is written as a small dot or diamond, ٥ as a small circle or loop. Do not read ٥ as zero: a circle is 5, a dot is 0 (so "٥٠٠" = 500, "٢٥٠" = 250).
- ٢ and ٣ differ by the teeth on top (٢ one, ٣ two). ٦ looks like a 7 with a short tail; ٧ is a V; ٨ is an upside-down V.
- A comma, dot or slash between digits can be a thousands separator ("2,500", "2.500") or a decimal half ("2,5" = 2500 by the thousands rule). Decide from the other amounts on the page.

For every entry, in the order it appears on the page:
- row: the printed row number ت of the row on the printed form, or 0 when the photo is not the printed form.
- written_name: the name exactly as written.
- customer_id: the id of the same person from the customer list. Allow for spelling variants (ة/ه، ى/ي، أ/إ/ا، with or without ال، shortened names, a nickname that clearly matches a listed name). Use "" when nobody in the list is the same person.
- A customer line may end with other ways the shop has written that person's name on earlier pages. A written name that matches one of those is that customer, with match "sure".
- match: "sure" when the match is clear, "unsure" when it is a plausible guess, "none" when customer_id is "".
- type: "debt" or "pay".
- amount_written: the amount exactly as written, digits and marks included (e.g. "5", "٢٥٠٠", "7½", "2,5").
- amount: whole dinars after applying the thousands rule to amount_written.
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
        required: ["row", "written_name", "customer_id", "match", "type", "amount_written", "amount", "amount_unsure", "note"],
        properties: {
          row: { type: "integer" },
          written_name: { type: "string" },
          customer_id: { type: "string" },
          match: { type: "string", enum: ["sure", "unsure", "none"] },
          type: { type: "string", enum: ["debt", "pay"] },
          amount_written: { type: "string" },
          amount: { type: "integer" },
          amount_unsure: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
  },
};

const ITEMS_SYSTEM = `You read photos for a small neighbourhood market in Iraq (ماركت) and list the goods in them, so the owner can add each item to the shop's cashier app.

The photo may be:
- a supplier's invoice or delivery note, printed or handwritten: usually one line per item with a quantity, a unit price and a line total;
- a handwritten list of goods;
- a photo of products on a shelf or in a box.

For every distinct item, in the order it appears:
- name: the item as a shop names it on its price list, in Arabic: brand, kind and size (e.g. بيبسي علبة 330 مل، رز محمود 10 كغم، فيري 500 مل). Write foreign brand names the way Iraqis write them in Arabic. Keep the size with its unit (مل، لتر، غم، كغم). Never put the quantity bought in the name.
- product_id: the id of the same item in the shop's item list (allow spelling variants, but only the same brand, kind and size). Use "" when it is not on the list.
- category: the closest section from the category list, written exactly as it is there.
- qty: how many were bought, counted in the unit the line uses (cartons when the line is in cartons). 0 when no quantity is shown (shelf photos, plain lists).
- pack_n: how many pieces are in one of those units: 1 when the line is per piece; the number of pieces when the line is per carton, packet or box and the count is shown or is the well-known standard for that product (e.g. 24 cans in a carton of Pepsi); 0 when unknown.
- cost: the purchase price of one unit as the line counts it (per carton when the line is per carton), in whole Iraqi dinars. When only a line total is shown, divide it by qty. 0 when no price is shown. Printed invoices write full amounts; handwritten ones often write thousands: the smallest banknote is 250, so a price below 250 is in thousands (5 → 5000, 2.5 → 2500, 0.75 → 750). Digits may be Arabic-Indic (٠١٢٣٤٥٦٧٨٩).
- weighed: true for goods sold by the kilogram (vegetables, fruit, loose nuts and sweets, meat), otherwise false.
- unsure: true when the name or the numbers are hard to read.

Merge repeated lines of the same item by adding their quantities. Skip crossed-out lines, totals, discounts, the supplier's name and phone, and dates: they are not items. Never invent items that are not in the photos. If the photos show no goods, return an empty list.

When the photo is an invoice or delivery note, also read its header (otherwise leave these empty):
- supplier_name: the shop, store or company that issued it (letterhead, stamp or written at the top), as written there, e.g. محلات المحبة. "" when not shown.
- supplier_phone: its phone number, digits only (keep a leading 0 or +). "" when not shown.
- invoice_no: the invoice or delivery note number. "" when not shown.
- invoice_total: the grand total to pay, in whole Iraqi dinars (same thousands rule as cost). 0 when not shown.`;

const ITEMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supplier_name", "supplier_phone", "invoice_no", "invoice_total", "items"],
  properties: {
    supplier_name: { type: "string" },
    supplier_phone: { type: "string" },
    invoice_no: { type: "string" },
    invoice_total: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "product_id", "category", "qty", "pack_n", "cost", "weighed", "unsure"],
        properties: {
          name: { type: "string" },
          product_id: { type: "string" },
          category: { type: "string" },
          qty: { type: "number" },
          pack_n: { type: "integer" },
          cost: { type: "integer" },
          weighed: { type: "boolean" },
          unsure: { type: "boolean" },
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
    .map(c => ({ id: c.id.slice(0, 64), name: c.name.replace(/[\n|]/g, " ").slice(0, 80),
      aliases: (Array.isArray(c.aliases) ? c.aliases : []).filter(a => typeof a === "string").slice(0, 8).map(a => a.replace(/[\n|,]/g, " ").slice(0, 40)) }));
  const clean = (x, n) => String(x).replace(/[\n|]/g, " ").slice(0, n);
  const products = (Array.isArray(b.products) ? b.products : [])
    .filter(p => p && typeof p.id === "string" && typeof p.name === "string")
    .slice(0, MAX_PRODUCTS)
    .map(p => ({ id: p.id.slice(0, 64), name: clean(p.name, 80) }));
  const cats = (Array.isArray(b.cats) ? b.cats : []).filter(c => typeof c === "string" && c.trim()).slice(0, 100).map(c => clean(c.trim(), 30));
  return { kind: b.kind === "items" ? "items" : "ledger", images, customers, products, cats };
}

class UserError extends Error {}

const customerList = input => input.customers.map(c => `${c.id}|${c.name}${c.aliases.length ? "|" + c.aliases.join(", ") : ""}`).join("\n") || "(no customers yet)";

// What each kind of photo needs: instructions, output shape, the list the model matches against, and the ask.
const MODES = {
  ledger: {
    system: SYSTEM, schema: SCHEMA, key: "rows",
    context: input => `Customer list (id|name|other ways the shop has written this name):\n${customerList(input)}`,
    ask: "Read every ledger entry in these photos.",
    tooLong: "الورقة طويلة كلش. صوّرها على قسمين.",
  },
  items: {
    system: ITEMS_SYSTEM, schema: ITEMS_SCHEMA, key: "items",
    context: input => `Category list:\n${input.cats.join("\n") || "مشكل"}\n\nThe shop's item list (id|name):\n${input.products.map(p => `${p.id}|${p.name}`).join("\n") || "(no items yet)"}`,
    ask: "List every item in these photos.",
    tooLong: "القائمة طويلة كلش. صوّرها على قسمين.",
  },
};

async function readWithClaude(env, input) {
  const mode = MODES[input.kind];
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: mode.schema } },
    system: mode.system,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: mode.context(input) },
        ...input.images.map(im => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
        { type: "text", text: mode.ask },
      ],
    }],
  });
  if (response.stop_reason === "refusal") return { error: "ما كدر يقرأ الصورة. جرّب صورة ثانية." };
  if (response.stop_reason === "max_tokens") return { error: mode.tooLong };
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  try { const all = JSON.parse(text); return { rows: all[mode.key], all }; } catch { throw new UserError("صار خطأ بقراءة النتيجة. حاول مرة ثانية."); }
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

// Free-tier models get busy (503) or hit their own daily quota (429), so try the next one before giving up.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.5-flash"];

async function readWithGemini(env, input) {
  const mode = MODES[input.kind];
  const base = env.GEMINI_URL || "https://generativelanguage.googleapis.com";
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL] : GEMINI_MODELS;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: mode.system }] },
    contents: [{
      role: "user",
      parts: [
        { text: mode.context(input) },
        ...input.images.map(im => ({ inline_data: { mime_type: im.media_type, data: im.data } })),
        { text: mode.ask },
      ],
    }],
    generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(mode.schema), temperature: 0 },
  });
  let r, j, lastStatus = 0;
  for (const model of models) {
    r = await fetch(`${base}/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body });
    j = await r.json().catch(() => ({}));
    if (r.ok) break;
    lastStatus = r.status;
    console.error("gemini", model, r.status, j.error && j.error.status, j.error && j.error.message);
    if (![404, 429, 500, 503].includes(r.status)) break;
  }
  if (!r.ok) {
    if (lastStatus === 429) throw new UserError("خلص الحد المجاني لهاليوم من Gemini. حاول باچر أو بعد شوية.");
    if (lastStatus === 503 || lastStatus === 500) throw new UserError("خدمة Gemini مضغوطة هسه. انتظر دقيقة وحاول مرة ثانية.");
    if (lastStatus === 400 && /API_KEY_INVALID|API key/i.test(JSON.stringify(j))) throw new UserError("مفتاح Gemini غير صحيح.");
    if (lastStatus === 401 || lastStatus === 403) throw new UserError("مفتاح Gemini مرفوض. تأكد منه.");
    if (lastStatus === 404) throw new UserError("موديل Gemini غير متوفر. لازم يتحدث السيرفر.");
    throw new UserError("تعذّر الاتصال بـ Gemini. حاول مرة ثانية.");
  }
  if (j.promptFeedback && j.promptFeedback.blockReason) return { error: "ما كدر يقرأ الصورة. جرّب صورة ثانية." };
  const cand = (j.candidates || [])[0] || {};
  if (cand.finishReason === "MAX_TOKENS") return { error: mode.tooLong };
  const text = ((cand.content && cand.content.parts) || []).filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("");
  try { const all = JSON.parse(text); return { rows: all[mode.key], all }; } catch { throw new UserError("صار خطأ بقراءة النتيجة. حاول مرة ثانية."); }
}

// GitHub often skips its own scheduled runs, so Cloudflare's cron (wrangler.toml [triggers]) starts the 2-hour Telegram report
// by dispatching .github/workflows/backup.yml. Needs the GH_DISPATCH_TOKEN secret (a GitHub token with Actions read/write on the repo).
async function dispatchReport(env) {
  if (!env.GH_DISPATCH_TOKEN) { console.log("GH_DISPATCH_TOKEN not set; skipping the 2-hour report."); return; }
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/backup.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "shahm-ai-cron", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: "main", inputs: { mode: "periodic", scheduled: "true" } }),
  });
  if (!r.ok) throw new Error(`GitHub dispatch failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchReport(env));
  },

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
      // Only the owner adds items in the cashier app.
      if (input.kind === "items" && auth.user.email !== env.OWNER_EMAIL) return json({ error: "إضافة المواد للمدير فقط." }, 403, cors);

      const useClaude = !!env.ANTHROPIC_API_KEY;
      const out = useClaude ? await readWithClaude(env, input) : await readWithGemini(env, input);
      if (out.error) return json({ error: out.error }, 422, cors);
      let rows = out.rows;

      if (input.kind === "items") {
        const pids = new Set(input.products.map(p => p.id));
        const items = (Array.isArray(rows) ? rows : []).map(r => ({
          name: String(r.name || "").replace(/\s+/g, " ").trim().slice(0, 80),
          product_id: pids.has(r.product_id) ? r.product_id : "",
          category: String(r.category || "").trim().slice(0, 30),
          qty: Math.min(100000, Math.max(0, Math.round((Number(r.qty) || 0) * 1000) / 1000)),
          pack_n: Math.min(1000, Math.max(0, Math.round(Number(r.pack_n) || 0))),
          cost: Math.max(0, Math.round(Number(r.cost) || 0)),
          weighed: !!r.weighed,
          unsure: !!r.unsure,
        })).filter(r => r.name).slice(0, MAX_ITEMS);
        // The invoice header, for the receiving screen: who it came from and its number and total.
        const a = out.all || {};
        const head = {
          supplier_name: String(a.supplier_name || "").replace(/\s+/g, " ").trim().slice(0, 60),
          supplier_phone: String(a.supplier_phone || "").replace(/[^\d+]/g, "").slice(0, 20),
          invoice_no: String(a.invoice_no || "").replace(/\s+/g, " ").trim().slice(0, 30),
          invoice_total: Math.max(0, Math.round(Number(a.invoice_total) || 0)),
        };
        console.log(`read ${items.length} items for ${auth.user.email} via ${useClaude ? "claude" : "gemini"}`);
        return json({ items, ...head }, 200, cors);
      }

      // Never trust an id the model returned unless it is one of ours.
      const ids = new Set(input.customers.map(c => c.id));
      const seen = new Set();
      rows = (Array.isArray(rows) ? rows : []).map(r => {
        const known = ids.has(r.customer_id);
        let amount = Math.max(0, Math.round(Number(r.amount) || 0)), unsure = !!r.amount_unsure;
        // No banknote is below 250 dinars, so a smaller amount is one the model forgot to read in thousands.
        if (amount > 0 && amount < 250) { amount *= 1000; unsure = true; }
        return {
          row: Math.max(0, Math.min(999, Math.round(Number(r.row) || 0))),
          written_name: String(r.written_name || "").slice(0, 80),
          customer_id: known ? r.customer_id : "",
          match: known ? (r.match === "sure" ? "sure" : "unsure") : "none",
          type: r.type === "pay" ? "pay" : "debt",
          amount_written: String(r.amount_written || "").slice(0, 20),
          amount,
          amount_unsure: unsure,
          note: String(r.note || "").slice(0, 140),
        };
      // Overlapping photos of the same printed sheet return the same row twice: keep it once.
      }).filter(r => { if (!r.row) return true; const k = `${r.row}|${r.written_name}|${r.amount}`; if (seen.has(k)) return false; seen.add(k); return true; });
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
