/**
 * InsureFlow AI — Lead Conversion Agent · production server (reference implementation)
 * -----------------------------------------------------------------------------------
 * Zero dependencies. Node 18+ (uses global fetch).
 *
 *   export OPENAI_API_KEY=sk-...
 *   export CRM_WEBHOOK=https://hooks.zapier.com/hooks/catch/xxx/yyy
 *   node server-example.js          → http://localhost:8787
 *
 * This replaces the scripted brain in index.html with a real model that can call
 * tools. The swap is deliberately small:
 *
 *   1. index.html stays exactly as-is (it's your demo + fallback UI).
 *   2. Point the chat composer at POST /api/chat instead of the local handle().
 *   3. agent-instructions.md becomes the system prompt, verbatim.
 *   4. knowledge-base.md goes in the `knowledge` field — the model is told it may
 *      only answer from that text and must hand off on anything else.
 *   5. Tool definitions below are the ones the agent calls. Each one is a real
 *      side effect; the agent never "pretends" to book.
 *
 * Everything is stateless per request except the in-memory session store, which
 * you replace with Redis/a DB the moment you have two users. See NOTES at bottom.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const MODEL = process.env.MODEL || "gpt-4o-mini";
const API_KEY = process.env.OPENAI_API_KEY || "";
const API_URL = process.env.API_URL || "https://api.openai.com/v1/chat/completions";
const CRM_WEBHOOK = process.env.CRM_WEBHOOK || "";

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* ------------------------------------------------------------------ *
 * 1. THE AGENT'S BRAIN — loaded straight from the markdown you edited
 * ------------------------------------------------------------------ */
const SYSTEM_PROMPT =
  read("agent-instructions.md") +
  "\n\n=== APPROVED KNOWLEDGE BASE (you may only answer from this) ===\n" +
  read("knowledge-base.md");

/* ------------------------------------------------------------------ *
 * 2. TOOLS — the difference between a chatbot and an agent
 * ------------------------------------------------------------------ */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "crm_upsert",
      description:
        "Create or update the lead record. Call whenever a field changes, and always before ending the conversation.",
      parameters: {
        type: "object",
        properties: {
          contact: { type: "object", properties: { first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, best_time: { type: "string" } }, required: ["first_name"] },
          business: { type: "object", properties: { legal_name: { type: "string" }, industry: { type: "string" }, units: { type: "integer" }, states: { type: "string" }, mc_dot_authority: { type: "string" }, current_carrier: { type: "string" } }, required: ["legal_name"] },
          need: { type: "object", properties: { lines: { type: "array", items: { type: "string" } }, renewal: { type: "string" }, urgency: { type: "string" } } },
          risk: { type: "object", properties: { loss_history_3yr: { type: "string" }, flags: { type: "array", items: { type: "string" } } } },
          qualification: { type: "object", properties: { score: { type: "integer" }, band: { type: "string" }, reasons: { type: "array", items: { type: "string" } } } },
          consent: { type: "object", properties: { ai_disclosure_accepted: { type: "boolean" }, email_opt_in: { type: "boolean" }, sms_opt_in: { type: "boolean" }, consent_text: { type: "string" } } },
        },
        required: ["contact", "qualification"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_meeting",
      description: "Hold a real calendar slot. Only call after the lead has agreed to a specific time and score >= 70.",
      parameters: { type: "object", properties: { slot: { type: "string" }, email: { type: "string" }, timezone: { type: "string" }, notes: { type: "string" } }, required: ["slot", "email"] },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_human",
      description: "Escalate to a licensed producer. Required for cancellations, non-renewals, claims, complaints, legal language, any request for a human, or any question the knowledge base does not answer.",
      parameters: { type: "object", properties: { reason: { type: "string" }, urgency: { type: "string", enum: ["same_day", "24h"] }, summary: { type: "string" }, contact_method: { type: "string" } }, required: ["reason", "urgency"] },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_followup",
      description: "Enrol a consented lead in the day 0/2/5/12 sequence. Never call without explicit opt-in for that channel.",
      parameters: { type: "object", properties: { channel: { type: "string", enum: ["email", "sms", "both"] }, sequence: { type: "string", enum: ["nurture_d0_d2_d5_d12", "renewal_reminder_30d"] }, consent_quote: { type: "string" } }, required: ["channel", "consent_quote"] },
    },
  },
  {
    type: "function",
    function: {
      name: "do_not_contact",
      description: "Permanent suppression across all channels. Call immediately on any opt-out, then stop the conversation.",
      parameters: { type: "object", properties: { channel: { type: "string" }, verbatim: { type: "string" } }, required: ["verbatim"] },
    },
  },
];

/* ------------------------------------------------------------------ *
 * 3. TOOL EXECUTION — plug your real systems in here
 * ------------------------------------------------------------------ */
const sessions = new Map(); // swap for Redis/DB in production

async function postWebhook(url, body) {
  if (!url) return { skipped: true, reason: "no webhook configured" };
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function executeTool(name, args, sessionId) {
  const s = sessions.get(sessionId) || { lead: {}, transcript: [], toolLog: [] };
  s.toolLog.push({ at: new Date().toISOString(), tool: name, args });
  sessions.set(sessionId, s);

  switch (name) {
    case "crm_upsert": {
      s.lead = { ...s.lead, ...args };
      const res = await postWebhook(CRM_WEBHOOK, { source: "ai_agent", session_id: sessionId, ...args });
      return { stored: true, downstream: res };
    }
    case "book_meeting": {
      // Real path: Google Calendar API / Cal.com / Calendly — create the event and
      // return the actual join link. Never claim a booking you did not make.
      const res = await postWebhook(CRM_WEBHOOK, { type: "meeting_booked", session_id: sessionId, ...args });
      return { status: "held_pending_confirm", slot: args.slot, downstream: res };
    }
    case "handoff_to_human": {
      const res = await postWebhook(CRM_WEBHOOK, { type: "human_handoff", session_id: sessionId, ...args });
      return { routed_to: "producer_on_call", sla: args.urgency === "same_day" ? "within 4 business hours" : "next business day", downstream: res };
    }
    case "schedule_followup": {
      if (!args.consent_quote) return { error: "Blocked: no consent quote supplied." };
      const res = await postWebhook(CRM_WEBHOOK, { type: "enrol_sequence", session_id: sessionId, ...args });
      return { enrolled: args.sequence, channel: args.channel, downstream: res };
    }
    case "do_not_contact": {
      s.suppressed = true;
      s.sequenceCancelled = true;
      const res = await postWebhook(CRM_WEBHOOK, { type: "suppression", session_id: sessionId, ...args });
      return { suppressed: true, sequences_cancelled: true, downstream: res };
    }
    default:
      return { error: "unknown tool: " + name };
  }
}

/* ------------------------------------------------------------------ *
 * 4. THE LOOP
 * ------------------------------------------------------------------ */
async function runAgent(sessionId, userText) {
  const s = sessions.get(sessionId) || { lead: {}, transcript: [], toolLog: [] };
  if (s.suppressed) return { reply: null, blocked: "session is on the do-not-contact list", toolLog: s.toolLog };

  s.transcript.push({ role: "user", content: userText });
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `Today is ${new Date().toISOString().slice(0, 10)}. Session ${sessionId}. Lead record so far: ${JSON.stringify(s.lead)}` },
    ...s.transcript.slice(-24),
  ];

  for (let hop = 0; hop < 6; hop++) {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.3, max_tokens: 500 }),
    });
    if (!r.ok) throw new Error(`model ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const msg = data.choices[0].message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep {} */ }
        const result = await executeTool(call.function.name, args, sessionId);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue; // let the model speak after acting
    }

    s.transcript.push({ role: "assistant", content: msg.content || "" });
    sessions.set(sessionId, s);
    return { reply: msg.content, toolLog: s.toolLog, lead: s.lead };
  }
  return { reply: "Let me get a producer to pick this up directly — one moment.", toolLog: s.toolLog, escalated: true };
}

/* ------------------------------------------------------------------ *
 * 5. HTTP
 * ------------------------------------------------------------------ */
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }); return res.end(); }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const html = read("index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    return res.end(html);
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      if (!API_KEY) return json(res, 503, { error: "OPENAI_API_KEY not set — the UI falls back to its scripted demo brain." });
      try {
        const { session_id = "anon", message } = JSON.parse(body || "{}");
        if (!message) return json(res, 400, { error: "message required" });
        json(res, 200, await runAgent(session_id, message));
      } catch (e) {
        json(res, 500, { error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/lead") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Your CRM receiver — or just point Zapier straight at the webhook instead.
      console.log("[lead]", body.slice(0, 800));
      json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { ok: true, model: MODEL, key: !!API_KEY });

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`InsureFlow agent on http://0.0.0.0:${PORT}`);
  console.log(`model=${MODEL}  api_key=${API_KEY ? "set" : "MISSING (demo brain only)"}  crm_webhook=${CRM_WEBHOOK ? "set" : "off"}`);
});

/* ------------------------------------------------------------------ *
 * NOTES — what to change before a real customer touches this
 * ------------------------------------------------------------------
 * 1. Sessions: in-memory here. Move to Redis with a TTL, or Supabase/Postgres.
 * 2. Rate limiting + a per-IP cap. An open endpoint is an open wallet.
 * 3. Auth: the widget should post a signed token, not a raw session id, or I can
 *    read someone else's lead.
 * 4. Idempotency on crm_upsert keyed on session_id so a retry doesn't duplicate.
 * 5. Log every tool call with an immutable timestamp — that log is your defence
 *    when a customer claims the bot promised a price (it didn't; you can prove it).
 * 6. E&O / compliance: have your carrier or compliance lead review
 *    agent-instructions.md and knowledge-base.md before launch, and re-review
 *    monthly. This is standard practice, not optional.
 * 7. Evaluations: keep a file of 50 real customer questions with the answer you
 *    want. Re-run it after every prompt change. That's your regression test.
 */
