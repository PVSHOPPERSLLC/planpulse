import { rewardLevel, sharedProfile } from './rewards.mjs';
import { buildPlan, scheduleClock, TIERS, TRACK_OPTIONS, validatePreferences } from './plans.mjs';

const ACTIVE = new Set(['active', 'trialing']);
const BILLING_BLOCKS_CHECKOUT = new Set([...ACTIVE, 'past_due', 'unpaid', 'paused', 'incomplete']);
const STRIPE_EVENTS = new Set([
  'checkout.session.completed', 'customer.subscription.created',
  'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed'
]);
const SESSION_DURATION = 30 * 24 * 60 * 60;
const COOKIE_SESSION = '__Host-planpulse-session';
const COOKIE_LOGIN = '__Host-planpulse-login';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function demand(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

const seconds = () => Math.floor(Date.now() / 1000);
const sql = (env, query, ...params) => env.DB.prepare(query).bind(...params);
const rows = async statement => (await statement.all()).results;
const appUrl = env => new URL(env.APP_ORIGIN);

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

function redirect(url, cookies = []) {
  const headers = new Headers({ Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function readCookie(request, name) {
  return (request.headers.get('Cookie') ?? '').split(';').map(value => value.trim())
    .find(value => value.startsWith(name + '='))?.slice(name.length + 1);
}

const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const sha256 = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function limitedText(request, maximum) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new HttpError(413, 'Request too large.');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof HttpError ? error : new HttpError(400, 'Invalid request body.');
  } finally {
    reader.releaseLock();
  }
}

function parseJson(value) {
  try { return JSON.parse(value); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
const readJson = async request => parseJson(await limitedText(request, 16_384));

async function beginLogin(request, env) {
  demand(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET, 503, 'Sign-in is being configured.');
  const tier = new URL(request.url).searchParams.get('tier');
  const state = randomToken();
  const verifier = randomToken();
  const challenge = base64url(new Uint8Array(await sha256(verifier)));
  const provider = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  provider.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: new URL('/api/auth/callback', appUrl(env)).href,
    response_type: 'code', scope: 'openid email', state, code_challenge: challenge, code_challenge_method: 'S256'
  });
  return redirect(provider.href, [cookie(COOKIE_LOGIN, `${state}.${verifier}.${Object.hasOwn(TIERS, tier) ? tier : '-'}`, 600)]);
}

async function finishLogin(request, env) {
  const url = new URL(request.url);
  const [state, verifier, tier] = (readCookie(request, COOKIE_LOGIN) ?? '').split('.');
  const clear = cookie(COOKIE_LOGIN, '', 0);
  const memberUrl = new URL('/member/', appUrl(env));
  const code = url.searchParams.get('code');
  if (Object.hasOwn(TIERS, tier)) memberUrl.searchParams.set('tier', tier);
  try {
    demand(verifier && code && state === url.searchParams.get('state'), 400, 'Sign-in expired.');
    const tokens = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code,
        redirect_uri: new URL('/api/auth/callback', appUrl(env)).href,
        grant_type: 'authorization_code', code_verifier: verifier
      })
    });
    demand(tokens.ok, 401, 'Sign-in failed.');
    const { access_token: token } = await tokens.json();
    demand(typeof token === 'string' && token, 401, 'Sign-in failed.');
    const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10_000)
    });
    demand(profile.ok, 401, 'Sign-in failed.');
    const { sub, email, email_verified: verified } = await profile.json();
    demand(verified === true && typeof sub === 'string' && sub && typeof email === 'string' && email,
      401, 'A verified Google account is required.');
    const member = await sql(env, `INSERT INTO members(id, google_sub, email) VALUES (?, ?, ?)
      ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email RETURNING id`,
      crypto.randomUUID(), sub, email).first();
    const sessionToken = randomToken();
    await sql(env, 'INSERT INTO sessions VALUES (?, ?, ?)', hex(await sha256(sessionToken)), member.id,
      seconds() + SESSION_DURATION).run();
    return redirect(memberUrl.href, [clear, cookie(COOKIE_SESSION, sessionToken, SESSION_DURATION)]);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('PlanPulse sign-in failed:', error.name);
    memberUrl.searchParams.set('login', 'retry');
    return redirect(memberUrl.href, [clear]);
  }
}

async function sessionDigest(request) {
  const token = readCookie(request, COOKIE_SESSION);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hex(await sha256(token)) : null;
}

async function getMember(request, env) {
  const digest = await sessionDigest(request);
  if (!digest) return null;
  return sql(env, `SELECT members.* FROM sessions JOIN members ON members.id = sessions.member
    WHERE sessions.digest = ? AND sessions.expires > ?`, digest, seconds()).first();
}

async function stripe(env, resource, data, idempotencyKey) {
  const keyMode = env.STRIPE_LIVE_MODE === 'true' ? 'live' : 'test';
  demand(new RegExp('^(?:sk|rk)_' + keyMode + '_').test(env.STRIPE_SECRET_KEY ?? '') &&
    ['true', 'false'].includes(env.STRIPE_LIVE_MODE),
    503, 'Billing is being configured.');
  const headers = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let response;
  try {
    response = await fetch('https://api.stripe.com/v1/' + resource, {
      method: data ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(10_000),
      body: data ? new URLSearchParams(data) : undefined
    });
  } catch {
    throw new HttpError(503, 'Billing is temporarily unavailable. Try again shortly.');
  }
  demand(response.ok, 503, 'Billing is temporarily unavailable. Try again shortly.');
  const result = await response.json();
  if (typeof result.livemode === 'boolean') {
    demand(result.livemode === (env.STRIPE_LIVE_MODE === 'true'), 503, 'Billing mode is misconfigured.');
  }
  return result;
}

function tierForPrice(env, price) {
  return Object.keys(TIERS).find(tier => env[TIERS[tier].priceVariable] === price && Boolean(price));
}

async function getBilling(env, member, fresh = false) {
  if (!member.stripe_customer) return member;
  const checked = Date.now();
  if (!fresh && checked - member.billing_checked < 60_000) return member;
  let access = null;
  let blocked = null;
  let previouslySubscribed = false;
  let cursor;
  do {
    const query = new URLSearchParams({ customer: member.stripe_customer, status: 'all', limit: '100' });
    if (cursor) query.set('starting_after', cursor);
    const subscriptions = await stripe(env, 'subscriptions?' + query);
    for (const subscription of subscriptions.data) {
      const tier = subscription.items.data.map(item => tierForPrice(env, item.price.id)).find(Boolean);
      if (!tier) continue;
      previouslySubscribed = true;
      if (BILLING_BLOCKS_CHECKOUT.has(subscription.status)) blocked = subscription.status;
      if (ACTIVE.has(subscription.status) && (!access || TIERS[tier].tracks > TIERS[access.tier].tracks)) {
        access = { tier, status: subscription.status };
      }
    }
    cursor = subscriptions.has_more ? subscriptions.data.at(-1).id : null;
  } while (cursor);
  await sql(env, `UPDATE members SET tier = ?, billing_status = ?, billing_checked = ?
    WHERE id = ? AND stripe_customer = ? AND billing_checked <= ?`,
    access?.tier ?? null, access?.status ?? blocked ?? 'none', checked,
    member.id, member.stripe_customer, checked).run();
  return { ...await sql(env, 'SELECT * FROM members WHERE id = ?', member.id).first(), previouslySubscribed };
}

async function stripeCustomer(env, member) {
  if (member.stripe_customer) return member.stripe_customer;
  const customer = await stripe(env, 'customers', { 'metadata[planpulse_member]': member.id },
    'planpulse-customer-' + member.id);
  await sql(env, 'UPDATE members SET stripe_customer = ? WHERE id = ? AND stripe_customer IS NULL',
    customer.id, member.id).run();
  return (await sql(env, 'SELECT stripe_customer FROM members WHERE id = ?', member.id).first()).stripe_customer;
}

async function checkout(env, member, input) {
  const tier = input?.tier;
  demand(Object.hasOwn(TIERS, tier), 400, 'Choose a subscription.');
  const customer = await stripeCustomer(env, member);
  const billing = await getBilling(env, { ...member, stripe_customer: customer }, true);
  demand(!BILLING_BLOCKS_CHECKOUT.has(billing.billing_status), 409, 'You already have a subscription. Open Manage billing.');
  const offer = TIERS[tier];
  const priceId = env[offer.priceVariable] ?? '';
  demand(/^price_[a-zA-Z0-9]+$/.test(priceId), 503, 'This plan is being configured.');
  const price = await stripe(env, 'prices/' + priceId);
  demand(price.active && price.currency === 'usd' && price.unit_amount === offer.price &&
    price.recurring?.interval === 'month' && price.recurring.interval_count === 1,
    503, 'This plan’s price needs to be checked.');
  const now = seconds();
  await sql(env, `INSERT INTO checkout_attempts (member, id, tier, trial, expires) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(member) DO UPDATE SET id = excluded.id, tier = excluded.tier, trial = excluded.trial,
    expires = excluded.expires, stripe_session = NULL WHERE checkout_attempts.expires <= ?`,
    member.id, crypto.randomUUID(), tier, billing.previouslySubscribed ? 0 : offer.trial, now + 2_400, now).run();
  const attempt = await sql(env, 'SELECT * FROM checkout_attempts WHERE member = ?', member.id).first();
  demand(attempt.tier === tier, 409, 'A checkout for another plan is open. Finish it or retry after it expires.');
  if (attempt.stripe_session) {
    const existing = await stripe(env, 'checkout/sessions/' + encodeURIComponent(attempt.stripe_session));
    demand(existing.status === 'open' && existing.url, 409, 'The last checkout is processing or expired. Refresh or try again shortly.');
    return { url: existing.url };
  }
  const params = {
    mode: 'subscription', customer, client_reference_id: member.id,
    'line_items[0][price]': priceId, 'line_items[0][quantity]': '1',
    'metadata[planpulse_member]': member.id,
    'subscription_data[metadata][planpulse_member]': member.id,
    payment_method_collection: 'always', 'allowed_payment_method_types[0]': 'card', expires_at: String(attempt.expires - 60),
    success_url: new URL('/member/?billing=return', appUrl(env)).href + '&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: new URL('/member/?billing=canceled', appUrl(env)).href,
  };
  if (attempt.trial) params['subscription_data[trial_period_days]'] = String(attempt.trial);
  const session = await stripe(env, 'checkout/sessions', params, 'planpulse-checkout-v2-' + attempt.id);
  await sql(env, 'UPDATE checkout_attempts SET stripe_session = ? WHERE member = ? AND id = ?',
    session.id, member.id, attempt.id).run();
  demand(session.url, 503, 'Checkout is temporarily unavailable.');
  return { url: session.url };
}

async function requireAccess(env, member) {
  const billing = await getBilling(env, member);
  demand(ACTIVE.has(billing.billing_status) && Object.hasOwn(TIERS, billing.tier), 403,
    'An active subscription or trial is required.');
  return billing;
}

async function stripeWebhook(request, env) {
  demand(env.STRIPE_WEBHOOK_SECRET, 503, 'Webhook is being configured.');
  const raw = await limitedText(request, 1_048_576);
  const fields = (request.headers.get('Stripe-Signature') ?? '').split(',').map(part => part.trim());
  const timestamp = fields.find(part => part.startsWith('t='))?.slice(2);
  demand(/^\d+$/.test(timestamp ?? '') && Math.abs(seconds() - Number(timestamp)) <= 300, 400, 'Invalid webhook signature.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signed = encoder.encode(timestamp + '.' + raw);
  const signatures = fields.filter(part => /^v1=[a-f0-9]{64}$/i.test(part));
  const verified = await Promise.all(signatures.map(part =>
    crypto.subtle.verify('HMAC', key, Uint8Array.from(part.slice(3).match(/../g), byte => parseInt(byte, 16)), signed)
  ));
  demand(verified.some(Boolean), 400, 'Invalid webhook signature.');
  const event = parseJson(raw);
  demand(event.livemode === (env.STRIPE_LIVE_MODE === 'true'), 400, 'Unexpected webhook mode.');
  if (STRIPE_EVENTS.has(event.type)) {
    const customer = event.data?.object?.customer;
    if (typeof customer === 'string') {
      const member = await sql(env, 'SELECT * FROM members WHERE stripe_customer = ?', customer).first();
      if (member) await getBilling(env, member, true);
    }
  }
  return json({ received: true });
}

async function publishPlan(env, member, week) {
  const saved = await sql(env, `SELECT settings FROM preferences WHERE member = ? AND effective_week <= ?
    ORDER BY effective_week DESC LIMIT 1`, member.id, week).first();
  if (!saved) return;
  const plan = buildPlan(JSON.parse(saved.settings), member.tier, week);
  await env.DB.batch([
    sql(env, `INSERT OR IGNORE INTO plans SELECT id, ?, ? FROM members
      WHERE id = ? AND tier = ? AND billing_status IN ('active','trialing')`,
      week, JSON.stringify(plan), member.id, member.tier),
    sql(env, `INSERT OR IGNORE INTO notices (member, id, message, created)
      SELECT member, ?, ?, ? FROM plans WHERE member = ? AND week = ?`,
      'published-' + week, `Your plan for the week of ${week} is ready.`, seconds(), member.id, week)
  ]);
}

async function remind(env, member, clock, plan) {
  if (!member.reminder_time || member.reminder_time > clock.time || !plan) return;
  const completed = await rows(sql(env, 'SELECT activity FROM progress WHERE member = ? AND week = ?', member.id, plan.week));
  const checked = new Set(completed.map(item => item.activity));
  const remaining = JSON.parse(plan.schedule).filter(activity => activity.date === clock.today && !checked.has(activity.id));
  if (!remaining.length) return;
  const message = remaining.length === 1
    ? `Today on your schedule: ${remaining[0].title}.`
    : `You have ${remaining.length} activities left on today’s schedule.`;
  await sql(env, 'INSERT OR IGNORE INTO notices (member, id, message, created) VALUES (?, ?, ?, ?)',
    member.id, 'daily-' + clock.today, message, seconds()).run();
}

async function dashboard(env, account, clock, selectedWeek, checkoutSession) {
  let confirmCheckout = false;
  if (!ACTIVE.has(account.billing_status) && account.stripe_customer && /^cs_(?:test|live)_[a-zA-Z0-9]+$/.test(checkoutSession ?? '')) {
    const session = await sql(env, 'SELECT stripe_session FROM checkout_attempts WHERE member = ?', account.id).first();
    confirmCheckout = session?.stripe_session === checkoutSession;
  }
  const member = await getBilling(env, account, confirmCheckout);
  const access = ACTIVE.has(member.billing_status);
  const output = {
    account: { email: member.email, tier: member.tier, status: member.billing_status, hasBilling: Boolean(member.stripe_customer) },
    currentWeek: clock.week, nextPreferencesWeek: clock.nextPreferencesWeek,
    tracks: TRACK_OPTIONS, tiers: Object.fromEntries(Object.entries(TIERS).map(([id, tier]) => [id, {
      name: tier.name, price: tier.price, tracks: tier.tracks, trial: tier.trial
    }]))
  };
  if (!access) return output;
  const current = await sql(env, 'SELECT week, schedule FROM plans WHERE member = ? AND week = ?', member.id, clock.week).first();
  if (!current) await publishPlan(env, member, clock.week);
  const history = await rows(sql(env, 'SELECT week FROM plans WHERE member = ? ORDER BY week DESC LIMIT 24', member.id));
  const week = history.some(item => item.week === selectedWeek) ? selectedWeek : clock.week;
  const plan = await sql(env, 'SELECT week, schedule FROM plans WHERE member = ? AND week = ?', member.id, week).first();
  const todayPlan = plan?.week === clock.activityWeek ? plan : await sql(env,
    'SELECT week, schedule FROM plans WHERE member = ? AND week = ?', member.id, clock.activityWeek).first();
  await remind(env, member, clock, todayPlan);
  const [progress, notices, preferences] = await Promise.all([
    rows(sql(env, 'SELECT activity FROM progress WHERE member = ? AND week = ?', member.id, week)),
    rows(sql(env, 'SELECT id, message, created, read FROM notices WHERE member = ? ORDER BY created DESC, id DESC LIMIT 30', member.id)),
    sql(env, 'SELECT settings, effective_week FROM preferences WHERE member = ? ORDER BY effective_week DESC LIMIT 1', member.id).first()
  ]);
  return {
    ...output, week, history: history.map(item => item.week), plan: plan ? JSON.parse(plan.schedule) : null,
    completed: progress.map(item => item.activity), notices, reminderTime: member.reminder_time,
    preferences: preferences ? JSON.parse(preferences.settings) : null,
    preferencesWeek: preferences?.effective_week ?? null
  };
}

async function changePreferences(env, member, input, clock) {
  const settings = validatePreferences(input, member.tier);
  demand(settings, 400, 'Choose the included plan types, a goal and preference for each, and at least one day.');
  const existing = await sql(env, 'SELECT 1 FROM preferences WHERE member = ? LIMIT 1', member.id).first();
  const week = existing ? clock.nextPreferencesWeek : clock.week;
  await sql(env, `INSERT INTO preferences VALUES (?, ?, ?)
    ON CONFLICT(member, effective_week) DO UPDATE SET settings = excluded.settings
    WHERE preferences.effective_week <> ? OR NOT EXISTS (SELECT 1 FROM plans WHERE member = ? AND week = ?)`,
    member.id, week, JSON.stringify(settings), clock.week, member.id, clock.week).run();
  if (!existing) await publishPlan(env, member, week);
  return json({ effectiveWeek: week });
}

async function changeProgress(env, member, input) {
  demand(typeof input?.week === 'string' && typeof input.activity === 'string' && typeof input.done === 'boolean',
    400, 'Invalid activity.');
  const plan = await sql(env, 'SELECT schedule FROM plans WHERE member = ? AND week = ?', member.id, input.week).first();
  demand(plan && JSON.parse(plan.schedule).some(activity => activity.id === input.activity), 404, 'Activity not found.');
  const statement = input.done ? 'INSERT OR IGNORE INTO progress VALUES (?, ?, ?)'
    : 'DELETE FROM progress WHERE member = ? AND week = ? AND activity = ?';
  await sql(env, statement, member.id, input.week, input.activity).run();
  return json({ done: input.done });
}

async function rewards(env, member, week) {
  const [personal, profile, board] = await Promise.all([
    sql(env, 'SELECT COUNT(*) AS activities FROM progress WHERE member = ? AND week = ?', member.id, week).first(),
    sql(env, 'SELECT first_name AS firstName, state FROM leaderboard_profiles WHERE member = ?', member.id).first(),
    rows(sql(env, `SELECT l.first_name AS firstName, l.state, COUNT(*) AS activities
      FROM leaderboard_profiles l JOIN progress p ON p.member = l.member
      JOIN members m ON m.id = l.member
      WHERE p.week = ? AND m.billing_status IN ('active','trialing')
      GROUP BY l.member, l.first_name, l.state
      ORDER BY activities DESC, l.first_name, l.state, l.member LIMIT 25`, week))
  ]);
  return json({ week, profile, personal: rewardLevel(personal.activities),
    leaderboard: board.map(entry => ({ ...entry, points: rewardLevel(entry.activities).points })) });
}

const plannerDate = day => new Date(day + 'T00:00:00Z');
const dateKey = date => date.toISOString().slice(0, 10);
const validPlannerDay = day => typeof day === 'string' && Number.isFinite(plannerDate(day).getTime()) &&
  dateKey(plannerDate(day)) === day;

function occursOn(task, day) {
  return task.day === day || (task.repeats && day > task.day &&
    plannerDate(day).getUTCDay() === plannerDate(task.day).getUTCDay());
}

async function planner(request, env, member, url, clock) {
  const month = url.searchParams.get('month');
  demand(/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(month ?? ''), 400, 'Choose a valid month.');
  const email = member.email.toLowerCase();
  const sharedOwner = url.searchParams.get('owner');
  const shared = Number(Boolean(sharedOwner));
  const owner = sharedOwner && sharedOwner !== 'mine'
    ? await sql(env, `SELECT members.*, planner_shares.permission FROM members JOIN planner_shares
        ON members.id = planner_shares.owner WHERE members.id = ? AND planner_shares.email = ?`,
      sharedOwner, email).first()
    : member;
  demand(owner, 403, 'You no longer have access to this planner.');
  const input = request.method === 'POST' ? await readJson(request) : null;
  const canEdit = owner.id === member.id || owner.permission === 'edit';
  const weekly = !shared && url.searchParams.get('weekly') === '1';
  const billing = shared || weekly || input?.repeats || input?.action === 'share'
    ? await getBilling(env, owner) : owner;
  const active = ACTIVE.has(billing.billing_status);
  const plus = active && ['plus', 'all'].includes(billing.tier);
  const all = active && billing.tier === 'all';
  demand(!shared || all, 403, 'This shared planner requires an active All-Access membership.');
  if (request.method === 'POST') {
    const action = input?.action;
    demand(canEdit, 403, 'You have view-only access.');
    if (action === 'share' || action === 'revoke') {
      demand(sharedOwner === 'mine' && all, 403, 'Only the All-Access planner owner can manage sharing.');
      const guest = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      demand(guest.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest) && guest !== email,
        400, 'Enter the Google sign-in email of the person you want to share with.');
      if (action === 'revoke') {
        await sql(env, 'DELETE FROM planner_shares WHERE owner = ? AND email = ?', owner.id, guest).run();
      } else {
        demand(['view', 'edit'].includes(input.permission), 400, 'Choose Can view or Can edit.');
        await sql(env, `INSERT INTO planner_shares VALUES (?, ?, ?)
          ON CONFLICT(owner, email) DO UPDATE SET permission = excluded.permission`,
        owner.id, guest, input.permission).run();
      }
    } else if (action === 'add') {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      demand(validPlannerDay(input.day) && input.day.startsWith(month + '-') && title.length > 0 &&
        title.length <= 120, 400, 'Enter a task of up to 120 characters and a valid date.');
      demand(!input.repeats || plus, 403, 'Weekly repeats require Plus or All-Access.');
      await sql(env, 'INSERT INTO planner_tasks (id, member, day, title, shared, repeats) VALUES (?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), owner.id, input.day, title, shared, Number(Boolean(input.repeats))).run();
    } else {
      demand(typeof input?.id === 'string' && (action === 'delete' ||
        (action === 'complete' && typeof input.done === 'boolean')), 400, 'Choose a valid task action.');
      const task = await sql(env, 'SELECT * FROM planner_tasks WHERE id = ? AND member = ? AND shared = ?',
        input.id, owner.id, shared).first();
      demand(task, 404, 'This task was not found.');
      if (action === 'delete') {
        await sql(env, 'DELETE FROM planner_tasks WHERE id = ? AND member = ? AND shared = ?',
          task.id, owner.id, shared).run();
      } else if (!task.repeats) {
        await sql(env, 'UPDATE planner_tasks SET done = ? WHERE id = ? AND member = ? AND shared = ?',
          Number(input.done), task.id, owner.id, shared).run();
      } else {
        demand(validPlannerDay(input.day) && input.day.startsWith(month + '-') && occursOn(task, input.day),
          400, 'Choose a scheduled occurrence.');
        if (input.done) await sql(env, 'INSERT OR IGNORE INTO planner_completions VALUES (?, ?)', task.id, input.day).run();
        else await sql(env, 'DELETE FROM planner_completions WHERE task = ? AND day = ?', task.id, input.day).run();
      }
    }
  }
  const first = plannerDate(month + '-01');
  const earliest = new Date(first);
  earliest.setUTCDate(first.getUTCDate() - 6);
  const [stored, completions, plans, incoming, guests, recapPlan, recapProgress] = await Promise.all([
    rows(sql(env, `SELECT id, day, title, done, repeats FROM planner_tasks
      WHERE member = ? AND shared = ? AND (day LIKE ? OR (repeats = 1 AND day <= ?)) ORDER BY day, title, id`,
      owner.id, shared, month + '-%', month + '-31')),
    rows(sql(env, `SELECT task, planner_completions.day FROM planner_completions JOIN planner_tasks ON task = id
      WHERE member = ? AND shared = ? AND planner_completions.day LIKE ?`, owner.id, shared, month + '-%')),
    weekly && active ? rows(sql(env, 'SELECT schedule FROM plans WHERE member = ? AND week BETWEEN ? AND ?',
      owner.id, dateKey(earliest), month + '-31')) : [],
    rows(sql(env, `SELECT owner AS id, members.email FROM planner_shares JOIN members ON owner = members.id
      WHERE planner_shares.email = ? AND billing_status IN ('active', 'trialing') AND tier = 'all' ORDER BY members.email`, email)),
    sharedOwner === 'mine' ? rows(sql(env, 'SELECT email, permission FROM planner_shares WHERE owner = ? ORDER BY email', owner.id)) : [],
    weekly && plus ? sql(env, 'SELECT schedule FROM plans WHERE member = ? AND week = ?', owner.id, clock.week).first() : null,
    weekly && plus ? rows(sql(env, 'SELECT activity FROM progress WHERE member = ? AND week = ?', owner.id, clock.week)) : []
  ]);
  const done = new Set(completions.map(item => item.task + '/' + item.day));
  const tasks = stored.flatMap(task => {
    if (!task.repeats) return [task];
    const items = [];
    for (const date = new Date(first); date.getUTCMonth() === first.getUTCMonth(); date.setUTCDate(date.getUTCDate() + 1)) {
      const day = dateKey(date);
      if (occursOn(task, day)) items.push({ ...task, day, done: done.has(task.id + '/' + day) });
    }
    return items;
  });
  const activities = plans.flatMap(plan => JSON.parse(plan.schedule)).filter(activity => activity.date.startsWith(month + '-'));
  const recap = recapPlan && { week: clock.week, total: JSON.parse(recapPlan.schedule).length, completed: recapProgress.length };
  return json({ tasks, activities, canEdit, canRepeat: plus, canShare: all && owner.id === member.id, incoming, guests, recap });
}

async function handle(request, env) {
  const url = new URL(request.url);
  const endpoint = url.pathname;
  const route = request.method + ' ' + endpoint;
  if (route === 'POST /api/stripe/webhook') return stripeWebhook(request, env);
  if (request.method === 'POST') {
    demand(request.headers.get('Origin') === appUrl(env).origin, 403, 'Request origin rejected.');
  }
  if (route === 'GET /api/health') {
    await sql(env, 'SELECT id FROM members LIMIT 1').first();
    return json({ ready: true });
  }
  if (route === 'GET /api/auth/login') return beginLogin(request, env);
  if (route === 'GET /api/auth/callback') return finishLogin(request, env);
  if (route === 'POST /api/auth/logout') {
    const digest = await sessionDigest(request);
    if (digest) await sql(env, 'DELETE FROM sessions WHERE digest = ?', digest).run();
    return redirect(new URL('/member/', appUrl(env)).href, [cookie(COOKIE_SESSION, '', 0)]);
  }
  const routes = new Set([
    'GET /api/dashboard', 'POST /api/checkout', 'POST /api/billing',
    'POST /api/preferences', 'POST /api/progress', 'POST /api/reminders', 'POST /api/notifications/read',
    'GET /api/rewards', 'POST /api/rewards/profile', 'GET /api/planner', 'POST /api/planner'
  ]);
  demand(routes.has(route), 404, 'This endpoint was not found.');
  const member = await getMember(request, env);
  demand(member, 401, 'Sign in to access your account.');
  const clock = scheduleClock();
  if (route === 'GET /api/dashboard') {
    return json(await dashboard(env, member, clock, url.searchParams.get('week'), url.searchParams.get('session_id')));
  }
  if (route === 'POST /api/checkout') return json(await checkout(env, member, await readJson(request)));
  if (route === 'POST /api/billing') {
    demand(member.stripe_customer, 404, 'This account has no billing profile.');
    const portal = await stripe(env, 'billing_portal/sessions', {
      customer: member.stripe_customer, return_url: new URL('/member/', appUrl(env)).href
    });
    return json({ url: portal.url });
  }

  if (route.endsWith(' /api/planner')) return planner(request, env, member, url, clock);
  const eligible = await requireAccess(env, member);
  if (route === 'GET /api/rewards') return rewards(env, eligible, clock.week);
  const input = await readJson(request);
  if (route === 'POST /api/rewards/profile') {
    const profile = sharedProfile(input);
    demand(profile !== null, 400, 'Enter a first name and a valid U.S. state.');
    if (profile) {
      await sql(env, `INSERT INTO leaderboard_profiles VALUES (?, ?, ?)
        ON CONFLICT(member) DO UPDATE SET first_name = excluded.first_name, state = excluded.state`,
        member.id, profile.firstName, profile.state).run();
    } else {
      await sql(env, 'DELETE FROM leaderboard_profiles WHERE member = ?', member.id).run();
    }
    return rewards(env, eligible, clock.week);
  }
  if (route === 'POST /api/preferences') return changePreferences(env, eligible, input, clock);
  if (route === 'POST /api/progress') return changeProgress(env, eligible, input);
  if (route === 'POST /api/reminders') {
    const time = input?.time;
    demand(time === null || typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time),
      400, 'Choose a reminder time or turn reminders off.');
    await sql(env, 'UPDATE members SET reminder_time = ? WHERE id = ?', time, member.id).run();
    return json({ time });
  }
  const before = input?.before;
  demand(Number.isInteger(before) && before > 0 && before <= seconds(), 400, 'Invalid notification date.');
  await sql(env, 'UPDATE notices SET read = 1 WHERE member = ? AND created <= ?', member.id, before).run();
  return json({ read: true });
}

export async function runSchedule(env, now) {
  const clock = scheduleClock(now);
  const expired = await rows(sql(env, `SELECT * FROM members WHERE stripe_customer IS NOT NULL
    AND billing_checked < ? ORDER BY billing_checked LIMIT 5`, now.valueOf() - 6 * 3_600_000));
  await Promise.allSettled(expired.map(async member => {
    try { await getBilling(env, member, true); }
    catch (error) { console.error('PlanPulse billing refresh failed:', error.status ?? error.name); }
  }));
  const due = await rows(sql(env, `SELECT * FROM members m WHERE m.billing_status IN ('active','trialing')
    AND EXISTS (SELECT 1 FROM preferences p WHERE p.member = m.id AND p.effective_week <= ?)
    AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.member = m.id AND p.week = ?)
    ORDER BY m.id LIMIT 10`, clock.week, clock.week));
  for (const member of due) await publishPlan(env, member, clock.week);

  const reminders = await rows(sql(env, `SELECT m.*, p.week, p.schedule FROM members m
    JOIN plans p ON p.member = m.id WHERE p.week = ? AND m.billing_status IN ('active','trialing')
    AND m.reminder_time <= ? AND EXISTS (SELECT 1 FROM json_each(p.schedule) activity
      WHERE json_extract(activity.value, '$.date') = ? AND NOT EXISTS (SELECT 1 FROM progress r
      WHERE r.member = m.id AND r.week = p.week AND r.activity = json_extract(activity.value, '$.id')))
    AND NOT EXISTS (SELECT 1 FROM notices n WHERE n.member = m.id AND n.id = ?)
    ORDER BY m.id LIMIT 10`, clock.activityWeek, clock.time, clock.today, 'daily-' + clock.today));
  for (const member of reminders) await remind(env, member, clock, member);
  await sql(env, 'DELETE FROM sessions WHERE expires <= ?', seconds()).run();
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('PlanPulse request failed:', error.name);
      return json({ error: 'PlanPulse is temporarily unavailable. Please try again.' }, 500);
    }
  },
  async scheduled(controller, env) {
    await runSchedule(env, new Date(controller.scheduledTime));
  }
};
