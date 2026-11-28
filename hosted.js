"use strict";
/*
 * Copyright (C) 2026 Sean O'Neill
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Hosted Range Book (2.54): the pieces a paid, public Range Book needs on top of the normal app, all switched off unless
 * HOSTED=true. A self-hosted Range Book never calls any of this.
 *   - email: Postmark or Resend over their web APIs (no packages); with no key set, emails are written to
 *     DATA_DIR/outbox/ and the log instead, so it can be tried out without an email account
 *   - Stripe: Checkout (to subscribe) and the Customer Portal (to change the card or cancel) over Stripe's web API, and
 *     checking the signature on Stripe's webhook calls. Card details never reach Range Book.
 *   - each account's state: trial, active, grace (a payment failed and Stripe is retrying) or lapsed (read-only)
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const on = (v) => /^(1|true|yes)$/i.test(String(v || ""));
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

function config(env = process.env) {
  return {
    hosted: on(env.HOSTED),
    publicUrl: String(env.PUBLIC_URL || "").replace(/\/+$/, ""),
    trialDays: num(env.TRIAL_DAYS, 30),
    deleteDays: num(env.DELETE_DAYS, 90),
    // deleting lapsed accounts is off until it's turned on, so a billing mix-up can never delete anyone by itself
    autoDelete: on(env.AUTO_DELETE_LAPSED),
    quotaMB: num(env.HOSTED_QUOTA_MB, 2048),
    // the prices as shown in Range Book (the real prices are the Stripe prices below)
    priceMonthLabel: env.PRICE_MONTH_LABEL || "$3 a month",
    priceYearLabel: env.PRICE_YEAR_LABEL || "$24 a year",
    email: {
      provider: String(env.EMAIL_PROVIDER || "").toLowerCase(), // "postmark" or "resend"; blank = write to the outbox folder
      key: env.EMAIL_KEY || "",
      from: env.EMAIL_FROM || "Range Book <no-reply@rangebook.org>",
    },
    stripe: {
      key: env.STRIPE_SECRET_KEY || "",
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
      priceMonth: env.STRIPE_PRICE_MONTHLY || "",
      priceYear: env.STRIPE_PRICE_YEARLY || "",
    },
  };
}

/* ---------------- email ---------------- */
function mailer(cfg, dataDir) {
  const outbox = path.join(dataDir, "outbox");
  return async function sendEmail(to, subject, text) {
    const e = cfg.email;
    if (!e.provider || !e.key) {
      // no email service set up: keep it in the outbox folder so it can be read (testing, or before the beta)
      fs.mkdirSync(outbox, { recursive: true });
      const f = path.join(outbox, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.txt`);
      fs.writeFileSync(f, `To: ${to}\nSubject: ${subject}\n\n${text}\n`);
      console.log(`Email to ${to} ("${subject}") saved in ${f} (no EMAIL_PROVIDER set).`);
      return true;
    }
    let url, headers, body;
    if (e.provider === "postmark") {
      url = "https://api.postmarkapp.com/email";
      headers = { "X-Postmark-Server-Token": e.key };
      body = { From: e.from, To: to, Subject: subject, TextBody: text, MessageStream: "outbound" };
    } else if (e.provider === "resend") {
      url = "https://api.resend.com/emails";
      headers = { Authorization: `Bearer ${e.key}` };
      body = { from: e.from, to: [to], subject, text };
    } else throw new Error(`EMAIL_PROVIDER "${e.provider}" isn't one Range Book knows (postmark or resend).`);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text().catch(() => ""); console.error(`Email to ${to} failed: ${r.status} ${t.slice(0, 300)}`); return false; }
    return true;
  };
}

/* ---------------- Stripe ---------------- */
// Stripe's API takes form fields, with nested ones written like line_items[0][price]
function form(obj, pre = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = pre ? `${pre}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
function stripe(cfg) {
  const call = async (method, p, fields) => {
    if (!cfg.stripe.key) { const e = new Error("Payments aren't set up on this Range Book yet."); e.status = 503; throw e; }
    const r = await fetch("https://api.stripe.com/v1/" + p, {
      method, headers: { Authorization: `Bearer ${cfg.stripe.key}`, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: fields ? form(fields).toString() : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`Stripe ${method} ${p}: ${r.status} ${(j.error && j.error.message) || ""}`); const e = new Error("The payment service didn't answer properly. Try again in a minute."); e.status = 502; throw e; }
    return j;
  };
  return {
    configured: () => !!(cfg.stripe.key && (cfg.stripe.priceMonth || cfg.stripe.priceYear)),
    checkout: (u, plan, base) => call("POST", "checkout/sessions", {
      mode: "subscription",
      line_items: { 0: { price: plan === "month" ? cfg.stripe.priceMonth : cfg.stripe.priceYear, quantity: 1 } },
      client_reference_id: String(u.id),
      ...(u.stripe_customer ? { customer: u.stripe_customer } : { customer_email: u.email || undefined }),
      // subscribing during the free trial: the first charge waits until the trial ends (Stripe needs 48 hours' notice)
      subscription_data: { metadata: { rangebook_user: String(u.id) }, ...(u.trial_ends && u.trial_ends > Date.now() + 2 * DAY ? { trial_end: Math.floor(u.trial_ends / 1000) } : {}) },
      metadata: { rangebook_user: String(u.id) },
      allow_promotion_codes: "true",
      success_url: `${base}/?billing=done`,
      cancel_url: `${base}/?billing=cancelled`,
    }),
    portal: (u, base) => call("POST", "billing_portal/sessions", { customer: u.stripe_customer, return_url: `${base}/?billing=back` }),
    cancelNow: (subId) => call("DELETE", "subscriptions/" + encodeURIComponent(subId)),
  };
}
/* Stripe signs each webhook call: header "t=<time>,v1=<hmac>", the HMAC-SHA256 of "<time>.<raw body>" with the webhook
   secret. Anything unsigned, wrongly signed or more than 5 minutes old is refused. */
function verifyWebhook(raw, header, secret, nowMs = Date.now()) {
  if (!secret || !header) return false;
  const parts = {};
  for (const kv of String(header).split(",")) { const i = kv.indexOf("="); if (i > 0) (parts[kv.slice(0, i).trim()] ||= []).push(kv.slice(i + 1).trim()); }
  const t = parts.t && +parts.t[0];
  if (!t || Math.abs(nowMs / 1000 - t) > 300) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
  return (parts.v1 || []).some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}
// when the subscription's paid period ends (newer Stripe API versions keep it on the subscription's item)
const periodEnd = (sub) => {
  const s = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  return s ? s * 1000 : null;
};
const planOf = (sub, cfg) => {
  const it = sub.items && sub.items.data && sub.items.data[0];
  const price = it && it.price;
  if (price && price.id === cfg.stripe.priceMonth) return "month";
  if (price && price.id === cfg.stripe.priceYear) return "year";
  const iv = price && price.recurring && price.recurring.interval;
  return iv === "month" ? "month" : iv === "year" ? "year" : null;
};

/* ---------------- account state ---------------- */
const DAY = 86400000;
/* What a hosted account can do right now:
   active  paid up (Stripe says active or trialing)
   grace   a payment failed and Stripe is still retrying (everything works, with a notice)
   trial   the free trial, no card yet
   lapsed  the trial or subscription ended: read-only (look and download, no changes), deleted after deleteDays
   Admins (the operator) are never limited. */
function accountState(u, cfg, t = Date.now()) {
  if (!cfg.hosted || !u || u.is_admin) return { state: "ok" };
  const sub = u.sub_status || "";
  if (sub === "active" || sub === "trialing") return { state: "active", until: u.paid_until || null, plan: u.plan || null, cancelAt: u.cancel_at || null };
  if (sub === "past_due") return { state: "grace", until: u.paid_until || null, plan: u.plan || null };
  const trialEnd = u.trial_ends || 0;
  if (t < trialEnd) return { state: "trial", until: trialEnd, daysLeft: Math.ceil((trialEnd - t) / DAY) };
  // when it ended: the day Stripe said the subscription stopped, or else the end of the trial or the paid time
  const since = u.lapsed_at || Math.min(t, Math.max(trialEnd, u.paid_until || 0)) || t;
  return { state: "lapsed", since, deleteAt: since + cfg.deleteDays * DAY, ...(u.stripe_sub ? {} : { trialOnly: true }) };
}
const readOnly = (st) => st.state === "lapsed";
/* While lapsed, these still work: looking (GET), signing out, your own account settings, paying, and the exports and
   backups that need a POST (to fill in vault serial numbers). Everything else that changes something is refused. */
const LAPSED_OK = /^\/api\/(logout|me(\/.*)?|billing\/.*|export(\/guns)?\.(xlsx|pdf)|sheet\/build)$/;

module.exports = { config, mailer, stripe, verifyWebhook, periodEnd, planOf, accountState, readOnly, LAPSED_OK, DAY };
