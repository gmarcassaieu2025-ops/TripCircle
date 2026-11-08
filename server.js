// TripCircle: AI trip planner with live web research.
// No dependencies. Needs Node 18+ and at least one API key (see README.md).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

/* ---------- provider adapters ---------- */

// Each provider has: research(prompt) -> {text, sources:[{title,url}]} (live web search)
//                    write(prompt)    -> text (no tools, used for questions + JSON)
const providers = {};

if (ANTHROPIC_KEY) {
  const call = async (body) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, ...body }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error("Anthropic: " + (j.error && j.error.message || r.status));
    return j;
  };
  providers.claude = {
    label: "Claude " + ANTHROPIC_MODEL,
    async research(prompt) {
      const j = await call({
        max_tokens: 6000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      });
      const sources = [];
      let text = "";
      for (const b of j.content || []) {
        if (b.type === "text") {
          text += b.text;
          for (const c of b.citations || []) if (c.url) sources.push({ title: c.title || c.url, url: c.url });
        }
        if (b.type === "web_search_tool_result" && Array.isArray(b.content))
          for (const x of b.content) if (x.url) sources.push({ title: x.title || x.url, url: x.url });
      }
      return { text, sources, live: true };
    },
    async write(prompt) {
      const j = await call({ max_tokens: 8000, messages: [{ role: "user", content: prompt }] });
      return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    },
  };
}

if (GEMINI_KEY) {
  const call = async (body) => {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body) }
    );
    const j = await r.json();
    if (!r.ok) throw new Error("Gemini: " + (j.error && j.error.message || r.status));
    return j;
  };
  const textOf = (j) => ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((p) => p.text || "").join("");
  providers.gemini = {
    label: "Gemini " + GEMINI_MODEL,
    async research(prompt) {
      let j;
      try {
        j = await call({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] });
      } catch (e) {
        // Search quota used up or not available on this key: answer from the model's knowledge instead.
        const t = textOf(await call({ contents: [{ role: "user", parts: [{ text: prompt }] }] }));
        return { text: t, sources: [], live: false };
      }
      const chunks = (j.candidates && j.candidates[0] && j.candidates[0].groundingMetadata && j.candidates[0].groundingMetadata.groundingChunks) || [];
      // Gemini returns redirect links; resolve them so the user sees the real page.
      const sources = [];
      for (const c of chunks) {
        if (!c.web) continue;
        let url = c.web.uri;
        try {
          const rr = await fetch(url, { redirect: "manual" });
          const loc = rr.headers.get("location");
          if (loc) url = loc;
        } catch (e) { /* keep redirect url */ }
        sources.push({ title: c.web.title || url, url });
      }
      return { text: textOf(j), sources, live: true };
    },
    async write(prompt) {
      return textOf(await call({ contents: [{ role: "user", parts: [{ text: prompt }] }] }));
    },
  };
}

/* ---------- helpers ---------- */

const firstProvider = () => Object.values(providers)[0];

function extractJson(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("No JSON in model reply");
  return JSON.parse(text.slice(s, e + 1));
}

async function writeJson(prompt) {
  const p = firstProvider();
  let text = await p.write(prompt);
  try { return extractJson(text); } catch (e) {
    text = await p.write(prompt + "\n\nYour previous reply was not valid JSON. Reply with ONLY one valid JSON object.");
    return extractJson(text);
  }
}

const profileText = (pr) =>
  `Destination: ${pr.destination}\nLength: ${pr.days} days\nWhen: ${pr.when || "flexible"}\nTravellers: ${pr.travellers || 2}\n` +
  `Budget: ${pr.budget || "mid-range"} (currency ${pr.currency || "EUR"})\nInterests: ${pr.interests || "not specified"}`;

const answersText = (a) => (a || []).map((x) => `- ${x.question} -> ${x.answer}`).join("\n") || "(none)";

/* ---------- API logic ---------- */

const clamp = (v, n) => String(v == null ? "" : v).slice(0, n);
function cleanProfile(p) {
  return { destination: clamp(p.destination, 80), days: Math.max(1, Math.min(14, +p.days || 3)), when: clamp(p.when, 60), travellers: Math.max(1, Math.min(12, +p.travellers || 2)), budget: clamp(p.budget, 20), currency: ["EUR", "USD", "GBP", "BRL"].includes(p.currency) ? p.currency : "EUR", interests: clamp(p.interests, 300) };
}

async function makeQuestions(profile) {
  const out = await writeJson(
    `You help plan trips. Trip so far:\n${profileText(profile)}\n\n` +
    `Write 5 short multiple-choice questions that would most change the itinerary for THIS destination ` +
    `(e.g. pace, famous sights vs hidden gems, food style, nightlife, mobility, day trips, crowds). ` +
    `Each question has 3-4 short options specific to the destination. ` +
    `Reply ONLY with JSON: {"questions":[{"id":"q1","text":"...","options":["...","..."]}]}`
  );
  return (out.questions || []).slice(0, 6);
}

async function makePlan(profile, answers, progress) {
  const names = Object.keys(providers);
  const researchPrompt =
    `Research a trip using live web search, then write detailed notes.\n\nTRIP\n${profileText(profile)}\n\nTRAVELLER PREFERENCES\n${answersText(answers)}\n\n` +
    `Find and report with specifics:\n` +
    `1. Best time of year for this trip, peak vs cheap months, weather and crowd notes for the given dates.\n` +
    `2. Best activities for these preferences, and for each: current price (note currency and where the price comes from), whether a reservation is needed, and how many weeks/months ahead to book.\n` +
    `3. Tips from real travellers and small local blogs, forums and Reddit (not only big travel sites): quirks, timing tricks, scams, local alternatives to tourist traps.\n` +
    `4. A few hidden gems that do not dominate the big maps.\n` +
    `5. Anything that may be closed, seasonal or changed recently.\n` +
    `Say clearly when something is uncertain or you could not find a price. Do not invent prices.`;

  progress(`Researching the web with ${names.map((n) => providers[n].label).join(" and ")}...`);
  const results = await Promise.allSettled(names.map((n) => providers[n].research(researchPrompt)));
  const notes = [], sources = [], seen = new Set();
  let anyLive = false;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      notes.push({ ai: providers[names[i]].label, text: r.value.text });
      if (r.value.live) anyLive = true;
      for (const s of r.value.sources) if (!seen.has(s.url)) { seen.add(s.url); sources.push(s); }
    } else progress(`${providers[names[i]].label} failed: ${r.reason.message}`);
  });
  if (!notes.length) throw new Error("All AI providers failed. Check your API keys.");

  progress(`Found ${sources.length} web sources. Merging ${notes.length} AI answer(s) into a plan...`);
  const srcList = sources.slice(0, 60).map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join("\n");
  const plan = await writeJson(
    `Turn these research notes into ONE trip plan as JSON.\n\nTRIP\n${profileText(profile)}\n\nPREFERENCES\n${answersText(answers)}\n\n` +
    notes.map((n) => `NOTES FROM ${n.ai}:\n${n.text}`).join("\n\n---\n\n") +
    `\n\nALLOWED SOURCES (only cite these; use the number):\n${srcList || "(none)"}\n\n` +
    `Rules: never invent prices or links. If a price is unknown use amount null. Mark priceBasis "source" if the notes give a price, otherwise "estimate". ` +
    `If the AI notes disagree, say so in "agreement". Use ${profile.currency || "EUR"}. Make exactly ${profile.days} days.\n` +
    `Reply ONLY with JSON in this shape:\n` +
    `{"title":"","summary":"2-3 sentences","bestTime":{"recommendation":"","peakMonths":"","cheapMonths":"","note":""},` +
    `"agreement":"where the AIs agreed or disagreed",` +
    `"days":[{"day":1,"theme":"","items":[{"time":"09:00","name":"","description":"","price":{"amount":0,"currency":"EUR","per":"person","basis":"source|estimate"},` +
    `"booking":{"needed":"yes|recommended|no|unknown","leadTime":"e.g. 3 weeks","how":""},"tip":"","sources":[1]}]}],` +
    `"localTips":[{"tip":"","sources":[1]}],"hiddenGems":[{"name":"","why":"","sources":[1]}],` +
    `"budget":{"currency":"EUR","perPersonTotal":0,"breakdown":[{"label":"","amount":0}]},` +
    `"bookingTimeline":[{"when":"e.g. 8 weeks before","what":""}],"caveats":[""]}`
  );

  // Replace source numbers with verified {title,url}; drop anything not in the allowed list.
  const lookup = (ids) => (ids || []).map((n) => sources[n - 1]).filter(Boolean);
  for (const d of plan.days || []) for (const it of d.items || []) it.sources = lookup(it.sources);
  for (const t of plan.localTips || []) t.sources = lookup(t.sources);
  for (const g of plan.hiddenGems || []) g.sources = lookup(g.sources);
  plan.allSources = sources.slice(0, 60);
  plan.generatedBy = notes.map((n) => n.ai);
  plan.liveSearch = anyLive;
  if (!anyLive) plan.caveats = ["Live web search was not available for this plan (quota or key limits), so prices and details come from the AI's own knowledge. Verify them before booking."].concat(plan.caveats || []);
  plan.generatedAt = new Date().toISOString();
  return plan;
}


/* ---------- protection for a public demo ---------- */
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "";
const PLANS_PER_IP_HOUR = +(process.env.PLANS_PER_IP_HOUR || 6);
const PLANS_PER_DAY = +(process.env.PLANS_PER_DAY || 60);
const hits = new Map();           // ip -> [timestamps]
let dayKey = "", dayCount = 0;
function allow(ip, kind) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  const key = ip + ":" + kind;
  const arr = (hits.get(key) || []).filter((t) => now - t < 3600e3);
  const limit = kind === "plan" ? PLANS_PER_IP_HOUR : PLANS_PER_IP_HOUR * 5;
  if (arr.length >= limit) return "Too many requests from your connection. Please try again in an hour.";
  if (kind === "plan" && dayCount >= PLANS_PER_DAY) return "The daily limit for this demo has been reached. Please try again tomorrow.";
  arr.push(now); hits.set(key, arr);
  if (kind === "plan") dayCount++;
  return null;
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const passwordOk = (req) => !DEMO_PASSWORD || req.headers["x-demo-password"] === DEMO_PASSWORD;

/* ---------- server ---------- */

const readBody = (req) => new Promise((res, rej) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch (e) { rej(e); } });
});

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, providers: Object.values(providers).map((p) => p.label), needsPassword: !!DEMO_PASSWORD }));
    }
    if (req.method === "POST" && req.url === "/api/questions") {
      if (!firstProvider()) throw new Error("No API key configured");
      if (!passwordOk(req)) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Wrong or missing demo password." })); }
      const lim = allow(clientIp(req), "questions");
      if (lim) { res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: lim })); }
      const { profile } = await readBody(req);
      const questions = await makeQuestions(cleanProfile(profile || {}));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ questions }));
    }
    if (req.method === "POST" && req.url === "/api/plan") {
      if (!firstProvider()) throw new Error("No API key configured");
      if (!passwordOk(req)) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Wrong or missing demo password." })); }
      const lim = allow(clientIp(req), "plan");
      if (lim) { res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: lim })); }
      const { profile, answers } = await readBody(req);
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      const send = (o) => res.write(JSON.stringify(o) + "\n");
      try {
        const plan = await makePlan(cleanProfile(profile || {}), (answers || []).slice(0, 8).map((a) => ({ question: clamp(a.question, 200), answer: clamp(a.answer, 100) })), (msg) => send({ type: "progress", msg }));
        send({ type: "result", plan });
      } catch (e) { send({ type: "error", msg: e.message }); }
      return res.end();
    }
    // static files
    const file = req.url === "/" ? "index.html" : req.url.split("?")[0].replace(/\.\./g, "");
    const fp = path.join(__dirname, "public", file);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(fp)] || "text/plain";
      res.writeHead(200, { "content-type": type + "; charset=utf-8" });
      return res.end(fs.readFileSync(fp));
    }
    res.writeHead(404); res.end("Not found");
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  const names = Object.values(providers).map((p) => p.label);
  console.log(`TripCircle running at http://localhost:${PORT}`);
  console.log(names.length ? "AI providers: " + names.join(", ") : "WARNING: set ANTHROPIC_API_KEY and/or GEMINI_API_KEY");
});
