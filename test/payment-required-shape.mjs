// Controls for payment-required.ts.
//
// Each case is a shape the gateway actually sends. The refusal case is the one
// that regressed before: handler_x402.go:334 returns
// `{"error":"payment verification failed","serviceId":…}` with no accepts[],
// and the client used to answer it with `trialExhausted: false`, a nextSteps
// line pointing at `accepts[0]`, and "pass autoPay: true" — advice the caller
// had already followed, since autoPay is what produced the refusal.
//
// Run: node test/payment-required-shape.mjs   (after `npm run build`)

import { paymentRequiredPayload } from "../dist/payment-required.js";

let failed = 0;
const ck = (label, cond) => {
  if (!cond) failed++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}`);
};

const SIG = "0x1111111111111111111111111111111111111111";
const CHALLENGE = {
  accepts: [
    {
      amount: "100000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      network: "eip155:8453",
      payTo: "0xAb62452b4b019bC4402BFfCca6C706d16d72A7Bf",
      scheme: "exact",
    },
  ],
  message: "Free trial calls are wallet-based …",
  nextSteps: ["1. Trial: …", "2. Pay: …"],
  trialExhausted: true,
  x402Version: 2,
};

// ── the refusal path (the bug this module exists for) ──────────────────
{
  const p = paymentRequiredPayload(
    { error: "payment verification failed", serviceId: "x402-time" },
    "Time",
    { trialSigner: SIG }
  );
  ck("R1 refusal keeps the server's own words", p.message === "payment verification failed");
  ck("R2 refusal invents no trial state", !("trialExhausted" in p));
  ck("R3 refusal carries no accepts[]", Array.isArray(p.accepts) && p.accepts.length === 0);
  const steps = (p.nextSteps || []).join(" ");
  ck("R4 refusal never points at accepts[0]", !steps.includes("accepts[0]"));
  ck("R5 refusal says nothing was charged", steps.toLowerCase().includes("nothing was charged"));
  ck("R6 refusal does not re-advise autoPay", !String(p.howToProceed).includes("pass autoPay: true"));
  ck("R7 refusal names the retry lever", String(p.howToProceed).includes("?probe=1"));
}

// ── the challenge path must keep working exactly as before ─────────────
{
  const p = paymentRequiredPayload(CHALLENGE, "Time", { trialSigner: SIG });
  ck("C1 challenge keeps accepts[]", p.accepts.length === 1 && p.accepts[0].payTo.startsWith("0x"));
  ck("C2 challenge keeps the server's trialExhausted", p.trialExhausted === true);
  ck("C3 challenge keeps the server's nextSteps", p.nextSteps[0] === "1. Trial: …");
  ck("C4 challenge names autoPay for a signed caller", String(p.howToProceed).includes("autoPay: true"));
  ck("C5 challenge keeps x402Version", p.x402Version === 2);
}

// ── a challenge that omits trialExhausted must not gain one ────────────
{
  const { trialExhausted, ...withoutFlag } = CHALLENGE;
  const p = paymentRequiredPayload(withoutFlag, "Time", { trialSigner: null, wallet: "0xabc" });
  ck("C6 absent trialExhausted stays absent", !("trialExhausted" in p));
  ck("C7 wallet-only caller gets the wallet= wording", String(p.howToProceed).includes("wallet= alone"));
}

// ── a challenge with no nextSteps still gets payable instructions ──────
{
  const { nextSteps, ...withoutSteps } = CHALLENGE;
  const p = paymentRequiredPayload(withoutSteps, "Time", { trialSigner: SIG });
  ck("C8 missing nextSteps falls back to the pay steps", (p.nextSteps || []).join(" ").includes("accepts[0]"));
}

// ── degenerate input must not throw ────────────────────────────────────
{
  const p = paymentRequiredPayload(null, "Time", { trialSigner: null });
  ck("D1 null body is a refusal, not a crash", p.status === "payment_required" && p.accepts.length === 0);
}

console.log(failed === 0 ? "\nall controls pass" : `\n${failed} control(s) failed`);
process.exit(failed === 0 ? 0 : 1);
