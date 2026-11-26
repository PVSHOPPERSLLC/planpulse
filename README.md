# PlanPulse member dashboard

PlanPulse uses GitHub Pages for the public site and member interface. A Cloudflare Worker on the same hostname handles Google sign-in, Stripe Checkout and billing, and the D1 data behind weekly plans, activity history, and dashboard notifications.

Members sign in before checkout. Stripe Checkout returns them to their PlanPulse account, where verified active or trialing subscriptions unlock onboarding. Saving the first set of preferences creates the first schedule immediately. Plans use a curated activity catalog and match the selected tracks, goals, preferences, and days. The scheduled job prepares the next plan at 7 AM Eastern on Sunday. Preferences saved by noon Eastern on Saturday apply to the upcoming release. Reminders appear in the member’s dashboard on scheduled days when activities remain incomplete.

## Local checks

Run `node --test` with Node 24 or newer. The test exercises the Worker handlers against an in-memory SQLite implementation of D1’s interface with simulated Google and Stripe responses. It covers checkout reuse, subscription status, first-plan generation, account isolation, reminders, plan history, and the Eastern time boundaries.

## Staging setup

1. Copy `wrangler.staging.example.jsonc` to the ignored `wrangler.staging.jsonc`. Replace the Workers subdomain in `APP_ORIGIN` with your staging account’s subdomain. The staging Worker serves both the homepage and member UI on the same hostname as the API. From the repository root, prepare the static files:

   ```sh
   mkdir -p .staging-assets/member
   cp index.html .staging-assets/
   cp member/index.html member/member.css member/member.js .staging-assets/member/
   ```
2. Create the D1 database, put its ID in the configuration, and run `npx wrangler d1 migrations apply planpulse-staging --remote --config wrangler.staging.jsonc`. [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
3. Create a Google OAuth web client with the exact redirect URI `https://<staging-host>/api/auth/callback`. Use the web client ID for `GOOGLE_CLIENT_ID`. Register `GOOGLE_CLIENT_SECRET` with `npx wrangler secret put` or the Worker’s secret settings. Add the intended testers to the OAuth application where applicable. [Google web server OAuth configuration](https://developers.google.com/identity/protocols/oauth2/web-server)
4. In Stripe test mode, configure the USD monthly prices of $9, $15, and $19 and fill in the three `STRIPE_PRICE_*` variables. Configure the Stripe customer portal for payment method management and cancellation. Register the test API key as `STRIPE_SECRET_KEY`. The server creates subscription Checkout Sessions and applies a seven-day trial to eligible first-time Plus and All-Access subscribers. [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create) · [Stripe customer portal](https://docs.stripe.com/customer-management)
5. Deploy the staging site using `npx wrangler deploy --config wrangler.staging.jsonc`. In the Stripe test account, register the HTTPS endpoint `https://<staging-host>/api/stripe/webhook` using snapshot events. Select `checkout.session.completed` and `customer.subscription.created`, `updated`, `deleted`, `paused`, and `resumed`. Register its signing secret as `STRIPE_WEBHOOK_SECRET`. Then check that `/api/health` returns `{"ready":true}`. [Stripe webhook setup](https://docs.stripe.com/webhooks) · [Cloudflare Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
6. On staging, verify sign-in, a Stripe test checkout, immediate onboarding, access after sign-in on another device, Sunday publication, reminders, cancellation, and the member’s return to the dashboard after billing. Verify the previous subscriber linking procedure if the old Payment Links had customers.

Keep provider secrets in the Worker secret settings. Test and production should each use their own Stripe mode, webhook secret, prices, OAuth configuration, and D1 database.

## Production rollout

The existing production hostname is `getplanpulseonline.online`. Keep the `CNAME` file and validate HTTPS through Cloudflare before enabling the production API route. Copy `wrangler.example.jsonc` to `wrangler.jsonc` for production. Deploy with the production Cloudflare route, OAuth client, and live-mode Stripe keys and prices after staging passes. Release the GitHub Pages changes after the API and webhook are ready, then confirm the homepage and member sign-in resolve. The release and daily reminder times follow U.S. Eastern civil time. Scheduled work is batched and the dashboard can publish a missing eligible plan when a member opens it. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

For a customer who paid through an earlier Payment Link, have them sign in and verify ownership of the existing Stripe subscription before associating that Stripe Customer ID with their PlanPulse member record. Review the live subscription’s price against the configured IDs and verify dashboard access before asking them to use the new checkout. The database enforces a unique Stripe customer per member record. The app uses the current Stripe subscription status after linking.

The web notifications feed is available through the member API. A future native app can use the same data after integrating native sign-in and device push registration.
