// answer-bank-pure.mjs — the alias-free half of the answer-bank overlay, so the
// unit test can import it under Node (same pattern as clean-chips.mjs).
// answer-bank.ts owns the spawn; everything here is pure.

/** "Job Application for X at Anthropic" / "Applied ML Engineer @ Deepgram" → the company, for scoped entries. */
export function companyFromTitle(title) {
  const m = String(title ?? "").match(/\bat\s+([A-Z][\w&.' -]{1,60})$/) || String(title ?? "").match(/@\s*([A-Z][\w&.' -]{1,60})$/);
  return m ? m[1].trim() : null;
}

/** Text block for the planner prompt's "durable notes". Verbatim answers, and
 *  an explicit instruction not to reinterpret them. */
export function bankMemoryBlock(m) {
  if (!m.auto.length && !m.confirm.length) return "";
  const line = (h) => `- ${h.label} → ${JSON.stringify(h.answer ?? "")}${h.confirm_each_time ? " (candidate confirms each time — set needs_confirmation:true, keep this as the value)" : ""}`;
  return [
    "Standing answers from the candidate's answer bank (data/answer-bank.json). Use them VERBATIM for these fields — do not rephrase, soften, or re-derive them from the CV:",
    ...m.auto.map(line),
    ...m.confirm.filter((h) => h.answer != null).map(line),
  ].join("\n");
}

/** Apply the bank on top of the planner's output. The bank is the candidate's
 *  own word; the planner never outranks it. Returns counts for the log. */
export function overlayBank(answers, m) {
  let auto = 0;
  let confirm = 0;
  for (const h of m.auto) {
    if (h.answer == null) continue;
    answers[h.id] = { value: String(h.answer), needs_confirmation: false };
    auto++;
  }
  for (const h of m.confirm) {
    const prev = answers[h.id] ?? {};
    answers[h.id] = { value: h.answer != null ? String(h.answer) : (prev.value ?? ""), needs_confirmation: true };
    confirm++;
  }
  return { auto, confirm };
}
