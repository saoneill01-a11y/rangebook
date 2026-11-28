# Running Range Book as a hosted service

This is for running one Range Book that the public can sign up for and pay to use (like `app.rangebook.org`). If you run Range Book for yourself, your family or your club, you don't need any of this: leave `HOSTED` off and nothing here appears.

With `HOSTED=true`, Range Book adds:

- **Create an account** on the sign-in page: name, email, password, and a box to agree to the Terms and Privacy policy. A link is emailed to confirm the address before the account can be used.
- **Sign in with an email address**, and **Forgot your password?** (an emailed link that works for an hour).
- **A free trial** (30 days by default, no card), then a **subscription** through Stripe, monthly or yearly. Subscribing during the trial doesn't cut it short: the first charge is when it ends.
- **More › Account › Subscription**: the plan, renewal date, and buttons that open Stripe's own pages to subscribe, change the card or plan, or cancel. Card details never reach Range Book.
- **When a trial or subscription ends**, the account is read-only: everything can still be looked at and downloaded (backup, Excel, PDF), but nothing can be added or changed until it's renewed. A notice at the top says when it will be deleted.
- **More › Account › Delete my account** (with the password), which also stops the subscription. **Change email** re-confirms the new address.
- Reminder emails: 3 days before a trial ends, and a week before a lapsed account would be deleted.
- Hosted defaults: guest mode off, community ammo sharing off, a 2 GB storage limit per person, and no sharing between accounts (no list of who else is on the server). Accounts with admin rights (you) are never limited.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `HOSTED` | `false` | `true` turns on everything on this page |
| `PUBLIC_URL` | *(the address the request came in on)* | The site's address for links in emails and the way back from Stripe, e.g. `https://app.rangebook.org` |
| `TRIAL_DAYS` | `30` | Length of the free trial |
| `DELETE_DAYS` | `90` | Days after a trial or subscription ends before the account is deleted |
| `AUTO_DELETE_LAPSED` | `false` | Deleting lapsed accounts only happens when this is `true` (and the warning email has gone out). Until then, accounts past their date are listed in the log and kept |
| `HOSTED_QUOTA_MB` | `2048` | Storage per person on a new hosted Range Book (change it later on the Admin page) |
| `PRICE_MONTH_LABEL` / `PRICE_YEAR_LABEL` | `$3 a month` / `$24 a year` | How the prices are shown in Range Book. The real prices are the Stripe prices below |
| `EMAIL_PROVIDER` | *(blank)* | `postmark` or `resend`. Blank: emails are written to `outbox/` in the data folder instead of sent (for testing) |
| `EMAIL_KEY` | | The email service's API key (Postmark server token, or Resend API key) |
| `EMAIL_FROM` | `Range Book <no-reply@rangebook.org>` | The sender. The domain has to be verified with the email service |
| `STRIPE_SECRET_KEY` | | Stripe secret key (`sk_test_…` while testing, `sk_live_…` for real) |
| `STRIPE_WEBHOOK_SECRET` | | The signing secret of the webhook below (`whsec_…`) |
| `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY` | | The Stripe price ids (`price_…`) for the two plans |

Also set `COOKIE_SECURE=true` and `TRUST_PROXY=true` (behind Fly's proxy, Cloudflare or a reverse proxy), and keep secrets out of files: on Fly, use `fly secrets set`.

## Stripe, step by step

1. In Stripe, make a product "Range Book" with two recurring prices (monthly and yearly). Put their ids in `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`.
2. **Developers › Webhooks › Add endpoint**: `https://<your address>/api/stripe/webhook`, with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. **Settings › Billing › Customer portal**: turn on updating the payment method, switching between the two prices, cancelling (at the end of the period), and invoice history.
4. **Settings › Billing › Subscriptions and emails › Manage failed payments**: retry for about two weeks, then **cancel the subscription**. While Stripe retries, the account keeps working with a "payment didn't go through" notice; when Stripe cancels it, the account turns read-only.
5. Try everything in test mode first (test card `4242 4242 4242 4242`), then switch the keys, prices and webhook to live mode.

## What's kept about each account

Besides the person's own Range Book data: their email address, whether it's confirmed, when they agreed to the Terms, the trial's end date, and from Stripe the customer and subscription ids, the plan, its status and when the paid period ends. Range Book never sees or stores card details.
