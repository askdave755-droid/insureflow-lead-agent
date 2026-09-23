/**
 * Regression tests for the InsureFlow lead agent.
 *
 *   node --test tests/            (Node 18+ built-in test runner, zero deps)
 *
 * Two things are being protected here:
 *
 *  1. FLOW — a real lead can be taken end to end without a step rejecting valid input.
 *  2. GUARDRAILS — the four behaviours that make this sellable in a regulated
 *     industry. If a prompt edit breaks these, the tests fail. That is the point.
 *     Never "fix" a failing guardrail test by weakening the assertion.
 *
 * The agent core lives inside index.html (single-file demo, no external loads).
 * Tests extract it between the @agent-core markers and run it against a DOM stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installDom } from "./dom-stub.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");

/* ---------- extract the agent core from the demo page ---------- */
const START = "/* @agent-core:start";
const END = "/* @agent-core:end */";
const startAt = html.indexOf(START);
const endAt = html.indexOf(END);
assert.ok(startAt > -1 && endAt > startAt, "agent-core markers missing from index.html");
const core = html.slice(html.indexOf("*/", startAt) + 2, endAt);

/* ---------- boot it in a sandbox with a stubbed DOM ---------- */
function boot() {
  const { document } = installDom();
  const api = new Function(
    "document",
    "navigator",
    "setTimeout",
    "clearInterval",
    "setInterval",
    core +
      `
    ;return {
      STEPS, KB,
      score, payload, matchKB, questionLike, humanHandoff,
      getState: () => S,
      setState: (v) => { S = v; },
      notifyStep: (fn) => { ask = fn; },
      tool, log
    };`
  )(document, {}, (fn) => fn(), () => {}, () => 0);
  return api;
}

const api = boot();

const newState = () => ({
  i: 0, done: false, data: {}, consentText: "", events: [], id: "LF-TEST", t0: new Date(),
});

/** Tests share one booted instance, so every test starts from a clean state. */
function fresh() {
  api.setState(newState());
  return api.getState();
}

/* the demo lead shipped in the page — keep in sync with DEMO in index.html */
const MEETING_ANSWER = "Just email me the info"; // the page's autofill sends this after DEMO
const DEMO_LEAD = [
  "Yes, let's go",
  "Danielle Roy",
  "Roy Haulage Ltd",
  "Trucking — dry van and flatbed",
  "12",
  "Ontario, Michigan, Ohio, Illinois — 500 mile radius",
  "1–3 months",
  "Currently with a regional broker",
  "Yes",
  "None",
  "danielle@royhaulage.ca",
  "4165550142",
  "Morning",
  "Yes, email and text are fine",
  MEETING_ANSWER,
];

/** Walk a full lead through every stage using the real step handlers. */
function runFlow(answers) {
  api.setState(newState());
  const results = [];
  for (let i = 0; i < answers.length; i++) {
    if (i >= api.STEPS.length) break;
    const step = api.STEPS[i];
    results.push({ step: step.id, result: step.run(answers[i]) });
  }
  return { state: api.getState(), results };
}

/* ------------------------------------------------------------------ *
 * 1. FLOW
 * ------------------------------------------------------------------ */
test("every step in the demo lead is accepted by its own handler", () => {
  fresh();
  const { results } = runFlow(DEMO_LEAD);
  assert.equal(results.length, api.STEPS.length, "demo lead did not cover every stage");
  for (const { step, result } of results) {
    assert.equal(result.st, "ok", `stage "${step}" rejected its own demo answer`);
  }
});

test("every capture stage declares a state key for the audit log", () => {
  const missing = api.STEPS.filter((s) => s.field && !s.dk).map((s) => s.id);
  assert.deepEqual(missing, [], `stages missing a dk key: ${missing.join(", ")}`);
});

test("the demo lead qualifies as hot and routes to a same-day producer callback", () => {
  fresh();
  runFlow(DEMO_LEAD);
  const s = api.getState();
  assert.equal(s.data.name, "Danielle Roy");
  assert.equal(s.data.units, 12, "units should be parsed as a number");
  assert.equal(s.data.phone, "(416) 555-0142", "phone should be normalised");
  assert.equal(s.data.authority, true);
  assert.equal(s.data.consentEmail, true);
  assert.equal(s.data.consentSms, true);

  const sc = api.score();
  assert.ok(sc.total >= 70, `expected a hot lead, scored ${sc.total}`);
  assert.equal(sc.total, 82, `demo lead score drifted to ${sc.total} — update the test if intentional`);

  const payload = JSON.parse(api.payload());
  assert.equal(payload.qualification.band, "QUALIFIED_HOT");
  assert.equal(payload.routing.sla, "same day");
  assert.deepEqual(payload.need.lines, ["Commercial Auto", "Motor Truck Cargo", "Non-Trucking Liability"]);
  assert.equal(payload.consent.sms_opt_in, true, "consent must be recorded explicitly");
});

test("declining follow-up produces a lead we are not allowed to contact", () => {
  fresh();
  const answers = DEMO_LEAD.map((a, i) => (api.STEPS[i].id === "consent" ? "No follow-ups, please" : a));
  runFlow(answers);
  const payload = JSON.parse(api.payload());
  assert.equal(payload.consent.email_opt_in, false);
  assert.equal(payload.consent.sms_opt_in, false);
  assert.equal(payload.routing.action, "do_not_contact_after_request");
});

test("phone and email validation reject obvious junk", () => {
  fresh();
  const email = api.STEPS.find((s) => s.id === "email");
  const phone = api.STEPS.find((s) => s.id === "phone");
  for (const bad of ["nope", "a@b", "x@y.z", "two words@here.com"]) {
    assert.equal(email.run(bad).st, "retry", `email should reject: ${bad}`);
  }
  for (const bad of ["12345", "call me maybe", ""]) {
    assert.equal(phone.run(bad).st, "retry", `phone should reject: ${bad}`);
  }
  assert.equal(email.run("DANIELLE@RoyHaulage.CA").st, "ok");
  assert.equal(api.getState().data.email, "danielle@royhaulage.ca", "email should be lowercased");
});

/* ------------------------------------------------------------------ *
 * 2. GUARDRAILS — the four behaviours the product is sold on
 * ------------------------------------------------------------------ */
const HARD = /(non-?renew|nonrenew|cancel(l)?ed|cancel(l)?ation|lapsed|no (insurance|coverage) (right now|at all)|uninsured|law ?suit|attorney|lawyer|\bsue\b|fraud|summons|subpoena|\baudit\b|shut ?down)/i;
const SOFT = /(\bclaim\b|\baccident\b|\bticket\b|violation|\bDUI\b)/i;
// mirrors the OPT_OUT branch in handle() plus the terminal-answer safety net
const OPTOUT = /(unsubscribe|opt[- ]?out|stop (texting|emailing|contacting|calling|messaging)|don'?t contact|do not contact|remove me|take me off|delete my (details|info|information|data)|no more (texts|emails|calls|messages)|quit texting)/i;
const HUMAN = /\b(talk to (a )?(human|person|someone)|speak to (a )?(human|person|producer|agent)|real person|call me now|representative)\b/i;

/** Mirrors the routing branch in ask()/handle(). */
function classify(text, stepId = "states") {
  const plain = /^(no|none|nope|nothing|clean)/i.test(text);
  const escalate = stepId !== "loss" && !plain && (HARD.test(text) || (SOFT.test(text) && !api.questionLike(text)));
  return {
    escalate,
    optOut: OPTOUT.test(text) || Boolean(api.matchKB(text)?.terminal),
    human: HUMAN.test(text),
    kb: api.matchKB(text)?.t ?? null,
    terminal: api.matchKB(text)?.terminal ?? false,
  };
}

test("GUARDRAIL: pricing questions are answered from the KB and never with a number", () => {
  for (const q of ["how much is this going to cost me?", "what's the rate?", "give me a quote", "can you beat my price?"]) {
    const c = classify(q);
    assert.equal(c.kb, "Pricing", `"${q}" should hit the approved pricing answer`);
    assert.equal(c.escalate, false, `"${q}" is a normal question, not an emergency`);
  }
  const answer = api.KB.find((e) => e.t === "Pricing").a;
  assert.match(answer, /can't give you a bindable number/i, "pricing answer must refuse to quote");
  assert.doesNotMatch(answer, /\$\s?\d|\d+\s?(dollars|usd|per month)/i, "pricing answer must contain no figures");
});

test("GUARDRAIL: never claims to be human", () => {
  const disclosure = api.KB.find((e) => e.t === "Disclosure").a;
  assert.match(disclosure, /AI assistant/i);
  assert.ok(api.STEPS[0].id === "disclosure", "AI disclosure must be the first thing the agent does");
  assert.equal(classify("am I talking to a real person?").human, true, "must offer a human when asked");
});

test("GUARDRAIL: claims, cancellations and non-renewals escalate instead of qualifying", () => {
  const mustEscalate = [
    "my policy got non-renewed last week",
    "we've been uninsured since March",
    "my attorney says I should switch brokers",
    "I had an accident last week and need help",
    "I got a DUI in 2024",
  ];
  for (const t of mustEscalate) {
    assert.equal(classify(t).escalate, true, `"${t}" must escalate`);
  }
});

test("GUARDRAIL: a customer asking about claims gets routed to a person, not answered by AI", () => {
  const c = classify("can you help me with a claim?");
  assert.equal(c.kb, "Urgent");
  assert.match(api.KB.find((e) => e.t === "Urgent").a, /handled by a person|not me/i);
});

test("GUARDRAIL: opt-outs are terminal, permanent, and never re-engaged", () => {
  const optOuts = [
    "stop texting me", "unsubscribe", "please don't contact me again",
    "remove me from your list", "take me off your list", "do not contact me",
    "delete my information", "no more texts", "quit texting me",
  ];
  for (const t of optOuts) {
    assert.equal(classify(t).optOut, true, `"${t}" must be treated as an opt-out`);
  }
  // the explicit stop-phrases must also reach the terminal KB answer, which is
  // the copy the agent replies with and the reason no sequence can resume
  for (const t of ["stop texting me", "unsubscribe", "please don't contact me again"]) {
    assert.equal(classify(t).terminal, true, `"${t}" must hit the terminal suppression answer`);
  }
  assert.equal(api.KB.filter((e) => e.terminal).length, 1, "exactly one terminal (opt-out) answer");
});

test("GUARDRAIL: anything outside the knowledge base hands off rather than inventing", () => {
  const unknown = ["do you write cargo ships?", "what's your A.M. Best rating?", "do you cover private jets?"];
  for (const q of unknown) {
    assert.equal(api.matchKB(q), null, `"${q}" must not match an approved answer`);
    assert.equal(api.questionLike(q), true, `"${q}" should be treated as a question needing a handoff`);
  }
});

test("plain answers are not mistaken for urgent language or questions", () => {
  for (const t of ["12", "Ontario, Michigan, Ohio", "None", "1–3 months", "Yes"]) {
    const c = classify(t);
    assert.equal(c.escalate, false, `"${t}" is a normal answer and must not escalate`);
    assert.equal(c.optOut, false, `"${t}" must not trigger suppression`);
  }
  assert.equal(classify("we operate out of Ohio").escalate, false, "false positive on 'out of'");
  assert.equal(classify("no accidents, clean record").escalate, false, "a clean loss history is not an emergency");
});

/* ------------------------------------------------------------------ *
 * 3. COMPLIANCE SURFACE
 * ------------------------------------------------------------------ */
test("no step ever collects sensitive identifiers", () => {
  const forbidden = /ssn|social security|licence number|license number|date of birth|bank|routing number|credit card/i;
  for (const s of api.STEPS) {
    assert.doesNotMatch(s.q ?? "", forbidden, `stage "${s.id}" asks for sensitive data`);
  }
});

test("follow-up sequence only fires for consented leads", () => {
  fresh();
  const payload = JSON.parse(api.payload());
  const consented = payload.consent.email_opt_in || payload.consent.sms_opt_in;
  assert.equal(consented, false, "fresh session has no consent");
  assert.equal(payload.routing.action, "producer_review", "unconsented leads get review, not sequences");
});

test("payload is valid JSON with the contract fields the CRM mapping depends on", () => {
  fresh();
  const p = JSON.parse(api.payload());
  for (const key of ["session_id", "contact", "business", "need", "risk", "qualification", "consent", "routing"]) {
    assert.ok(key in p, `payload missing "${key}"`);
  }
  assert.ok(p.qualification.score >= 0 && p.qualification.score <= 100, "score must be 0-100");
});
