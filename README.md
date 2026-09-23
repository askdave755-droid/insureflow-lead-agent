# InsureFlow AI · Lead Conversion Agent
A working lead-conversion agent for commercial insurance — built to be demoed today and sold next week.
This is **Direction B**: build one useful agent, run it in your own business, then turn the working system into an offer.

---

## Start here

**1. Open `index.html`** — click **"Run full demo lead"** and watch.
That single click shows a trucking lead get qualified, scored, consented, and routed, with the CRM payload and audit log filling in live on the right.

**2. Try to break it.** Type these four things:
| Type this | What you should see |
|---|---|
| `just give me a ballpark price` | It refuses, warmly, and routes to a human (rule R2) |
| `my policy got non-renewed last week` | It escalates immediately instead of qualifying (R9) |
| `do you write cargo ships?` | It says it will confirm rather than invent (R5) |
| `stop texting me` | Instant permanent suppression, conversation ends (R8) |

Those four responses **are the product.** Anyone can wire an LLM to a website; the guardrails are what makes it sellable in a regulated industry.

**3. Make it yours.** Search `index.html` for `const DEMO` and swap the sample company for a business you'd actually want as a client. Change "Marcus" to your producer. Then put it on a real URL (Netlify drop, Cloudflare Pages — free, ~10 minutes).

---

## The files

| File | What it is | When you use it |
|---|---|---|
| **`index.html`** | The live agent. Self-contained, no API key, no internet needed. Scripted brain + full UI: lead scorecard, CRM payload builder, system prompt, tool log. | Demo, and your client-facing link |
| **`agent-instructions.md`** | The system prompt. Role, 12 hard rules, conversation arc, scoring rubric, tool list, follow-up policy, edge cases. Replace every `[[ ]]`. | Day 2 — this is the brain |
| **`knowledge-base.md`** | Approved answers only. Company facts, appetite, required info by line, 16 FAQ answers, escalation triggers. | Day 2 — this is what stops it hallucinating |
| **`server-example.js`** | The go-live path. Zero-dep Node server: `agent-instructions.md` as the system prompt, 5 real tools, model loop, webhook out. | Day 4 — swap the scripted brain for a real model |
| **`crm-schema.sql`** | Postgres schema: leads, append-only event log, transcript, suppression list, follow-up queue with a database-level consent guard. Includes the monthly client scorecard view. | Day 4 — if you self-host instead of Zapier |
| **`voice-script.md`** | How to sell it. Opener, 3 diagnostic questions, offer framing, 4 objections with exact words, the close, contract non-negotiables. | Day 7 — read once out loud before your first call |
| **`sales-assets.md`** | 4-minute demo script with timings, one-pager copy, prospect tiers with a disqualify list, payback table. | Day 6 — the send-able material |
| **`roadmap-7-day.md`** | Your 7 days, filled in with done-when criteria, a 20-point break-it test, and honest expectations. | Day 1 — follow it in order |

---

## Run the tests

```bash
node --test tests/       # or: npm test   — 15 tests, zero dependencies, ~0.3s
```

The 15 tests cover two things, and both matter for different reasons:

**Flow** — a lead can be taken end to end without any stage rejecting valid input; the
demo lead scores 82 and routes to a same-day callback; consent is recorded explicitly.

**Guardrails** — the four behaviours this product is actually sold on are asserted, so a
future prompt edit cannot quietly weaken them:

| Test | Protects |
|---|---|
| `GUARDRAIL: pricing questions are answered from the KB and never with a number` | R2 — refuses to quote, and asserts the answer copy contains no dollar signs |
| `GUARDRAIL: never claims to be human` | R1 — disclosure is the first step, and a human is offered on request |
| `GUARDRAIL: claims, cancellations and non-renewals escalate` | R9 — five real-world phrasings must escalate, not qualify |
| `GUARDRAIL: opt-outs are terminal, permanent, and never re-engaged` | R8 — nine opt-out phrasings, and the terminal answer must be reached |
| `GUARDRAIL: anything outside the knowledge base hands off rather than inventing` | R5 — no invented answers |
| `no step ever collects sensitive identifiers` | R6 — no SSN, licence, or banking fields anywhere in the flow |

**Never fix a failing guardrail test by weakening the assertion.** If a test in that table
fails, the agent has regressed and a customer would be exposed.

The tests extract the agent core out of `index.html` between the `@agent-core` markers and
run it against a small DOM stub — no jsdom, no browser, no network. Keep those markers.

---

## Repo layout

```
.
├── index.html              # the live agent + demo UI (single file, no dependencies)
├── agent-instructions.md   # system prompt: role, 12 hard rules, scoring, edge cases
├── knowledge-base.md       # approved answers only — what stops it inventing
├── server-example.js       # zero-dep Node server: real model + 5 tool calls
├── crm-schema.sql          # Postgres + consent guard + append-only audit log
├── voice-script.md         # how to sell it: opener, objections, close
├── sales-assets.md         # demo script, one-pager, prospect tiers
├── roadmap-7-day.md        # the 7-day build plan
├── tests/                  # 15 tests, no dependencies
│   ├── agent.test.mjs
│   └── dom-stub.mjs
├── .github/workflows/      # CI: runs the tests on every push
└── .env.example            # copy to .env (gitignored)
```

---

## Running the production server (optional, Day 4)

```bash
export OPENAI_API_KEY=sk-...        # any OpenAI-compatible endpoint; set API_URL to change vendor
export CRM_WEBHOOK=https://hooks.zapier.com/hooks/catch/xxx/yyy
node server-example.js              # → http://localhost:8787  (/healthz for status)
```

Without a key it still serves the UI and reports `api_key=MISSING` — the demo never depends on the API being up.

**Before a real customer touches it:** read the NOTES block at the bottom of `server-example.js`. Sessions, rate limits, auth, idempotency, and the compliance review are all listed there. None of them are optional once real leads are flowing.

---

## What's real and what's a placeholder

**Real and tested:** the conversation flow, scoring rubric, the guardrail behaviours above, escalation logic, CRM payload shape, consent capture, suppression handling, the Node server, and the SQL schema — covered by 15 tests that run on every push via GitHub Actions.

**Placeholders you must replace:** every `[[ ]]` in the two markdown files, the company and producer names, the webhook URL, the calendar slots, and the pricing (the numbers in `voice-script.md` are researched starting points for a North American service business — validate them in your market).

**Deliberately not built:** outbound cold outreach at scale. CASL/TCPA/DNC compliance is a different project with real legal exposure. Don't add it until you've done that homework.

---

## The one-sentence version

The demo is the sales call. You will not need to explain AI to anyone — you'll put the agent in front of them, type *"just give me a ballpark price,"* and let it refuse. That silence sells the pilot.

**Nobody buys an agent. They buy the after-hours lead that stops going to voicemail.**
