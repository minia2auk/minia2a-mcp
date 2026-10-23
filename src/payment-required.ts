// Normalising the two different 402s this client can receive.
//
// The gateway answers a call with a 402 in two distinct shapes, and they mean
// different things:
//
//   challenge  — `accepts[]` (amount/asset/network/payTo), `message`,
//                `nextSteps[]`, and usually `trialExhausted: true`.
//                This is the document an agent pays against.
//
//   refusal    — `{"error":"payment verification failed","serviceId":…}` and
//                nothing else. This is what a *failed payment attempt* gets
//                (handler_x402.go:334; the same shape for "payment settlement
//                failed" at :381). It is deliberately NOT a payable document —
//                http-refusal-shape-guard.py requires refusals to be unreadable
//                as challenges, so a client cannot mistake a rejection for a
//                fresh invoice and re-sign/re-pay it.
//
// Before this module the client flattened both into one object, which produced
// three false statements on the refusal path:
//
//   * `trialExhausted: false` — the refusal says nothing about trial state, so
//     `?? false` invented a fact. Absent must stay absent (the same rule the
//     server-side absent-upstream guards enforce on the gateway's own output).
//   * `nextSteps` told the caller to "send USDC to the payTo address in
//     accepts[0]" — on this path `accepts` is empty, so the instruction pointed
//     at nothing.
//   * `howToProceed` said "pass autoPay: true together with this privateKey" —
//     advice the caller had already followed, since autoPay is what produced
//     the refusal.
//
// Nothing here changes when a call succeeds or what is charged; it only stops
// the client from asserting things the response did not say.

export type TrialContext = {
  /** Address derived from the caller's key, or null when no usable key was given. */
  trialSigner: string | null;
  /** The bare `wallet` argument, used only for the wording when there is no key. */
  wallet?: string;
};

const PAY_STEPS = [
  "1. Get 5 free trial calls: call with privateKey to sign 'minia2a trial:<wallet>:<serviceId>:<ts>' (no registration).",
  "2. Or pay per call: send USDC to the payTo address in accepts[0], then retry with a PAYMENT-SIGNATURE header (x402 V2).",
];

const REFUSAL_STEPS = [
  "Nothing was charged: this 402 is a refusal, not a fresh challenge, so it carries no accepts[] to pay against.",
  "Request the live challenge again with ?probe=1 to read the current amount, asset, network and payTo.",
  "The usual causes are a wallet short of USDC on Base, a token allowance too low for the x402 authorization, or an authorization whose validBefore has already passed.",
];

function refusalAdvice(ctx: TrialContext): string {
  if (ctx.trialSigner) {
    return `Signed as ${ctx.trialSigner}. The call was refused and nothing was charged. If this wallet still has trials, the signature was rejected; otherwise its 5 trials are spent and the payment attempt itself failed — check it holds USDC on Base with an allowance the x402 authorization can draw on, then re-request the challenge with ?probe=1.`;
  }
  if (ctx.wallet) {
    return "wallet= alone does not reach the wallet trial bucket. Pass privateKey (or set MINIA2A_PRIVATE_KEY) so the call can be signed, or pay per call.";
  }
  return "No signed-wallet trials. Pass privateKey to sign this wallet for its 5 free trial calls (no registration), or pay per call.";
}

/** Shape a 402 body into the object this client returns to the agent. */
export function paymentRequiredPayload(
  payment: unknown,
  serviceName: string,
  ctx: TrialContext
): Record<string, unknown> {
  const doc: any = payment && typeof payment === "object" ? payment : {};
  const accepts = Array.isArray(doc.accepts) ? doc.accepts : [];
  const hasChallenge = accepts.length > 0;

  const out: Record<string, unknown> = {
    status: "payment_required",
    service: serviceName,
    x402Version: doc.x402Version ?? 2,
    message: doc.message || doc.error || "Payment required.",
    accepts,
    nextSteps: Array.isArray(doc.nextSteps) ? doc.nextSteps : hasChallenge ? PAY_STEPS : REFUSAL_STEPS,
    howToProceed: hasChallenge
      ? ctx.trialSigner
        ? `Signed as ${ctx.trialSigner}. This wallet's trials are spent — pay per call via x402, or pass autoPay: true together with this privateKey to have the 402 paid in USDC on Base and the call retried.`
        : refusalAdvice(ctx)
      : refusalAdvice(ctx),
  };

  // Echo trial state only when the response stated it AND the client actually
  // identified a wallet. The gateway's anonymous branch sets
  // `trialExhausted: true` for every caller that arrives without a signature
  // (handler_discovery.go:199, handler_x402.go:897, handler_mcp.go:214): on
  // that path the field means "this anonymous call has no trial", not "this
  // wallet's 5 are spent". Passing it through told a first-time caller its
  // free allowance was gone before it had used one — and an agent that
  // branches on the boolean walks away from the trial path entirely.
  //
  // Identification here means we signed (trialSigner) or the server attached
  // the per-wallet `trial` object {mode,wallet,remaining,max}, which it does
  // only on the exhausted-with-a-wallet branch. Anonymous + true becomes
  // `trialIdentityRequired`, which is what the caller can act on.
  const identified = Boolean(ctx.trialSigner) || (doc.trial && typeof doc.trial === "object");
  if (typeof doc.trialExhausted === "boolean" && identified) {
    out.trialExhausted = doc.trialExhausted;
  } else if (doc.trialExhausted === true) {
    out.trialIdentityRequired = true;
  }

  return out;
}
