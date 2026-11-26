import { rewardLevel } from '../worker/rewards.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import worker, { runSchedule } from '../worker/index.mjs';
import { scheduleClock, validatePreferences } from '../worker/plans.mjs';

const origin = 'https://getplanpulseonline.online';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../migrations/0001_members.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_leaderboard.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_planner.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0004_planner_features.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0005_calendar_feed.sql', import.meta.url), 'utf8'));
  return {
    prepare(query) {
      const statement = db.prepare(query);
      return {
        bind(...args) {
          return {
            first: async () => statement.get(...args) ?? null,
            all: async () => ({ results: statement.all(...args) }),
            run: async () => statement.run(...args)
          };
        }
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

test('first plan, subscription lifecycle, progress, reminders and history', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-25T18:00:00Z') });
  const DB = database();
  const env = {
    DB, APP_ORIGIN: origin, GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'fixture',
    STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', STRIPE_LIVE_MODE: 'false',
    STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PLUS: 'price_plus', STRIPE_PRICE_ALL: 'price_all'
  };
  let stripeStatus = null;
  let stripePrice = 'price_plus';
  let checkouts = 0;
  let user = 'first';
  let existingCheckout;
  t.mock.method(globalThis, 'fetch', async (resource, options) => {
    const url = new URL(resource);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      assert.match(options.body.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
      return Response.json({ access_token: 'verified-by-provider' });
    }
    if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.equal(options.headers.Authorization, 'Bearer verified-by-provider');
      return Response.json({ sub: user, email: user + '@example.com', email_verified: true });
    }
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(options.headers.Authorization, 'Bearer sk_test_fixture');
    if (url.pathname === '/v1/customers') {
      assert.match(options.headers['Idempotency-Key'], /^planpulse-customer-/);
      return Response.json({ id: 'cus_A', livemode: false });
    }
    if (url.pathname === '/v1/subscriptions') {
      assert.equal(url.searchParams.get('customer'), 'cus_A');
      return Response.json({ data: stripeStatus ? [
        { id: 'sub_A', status: stripeStatus, items: { data: [{ price: { id: stripePrice } }] } }
      ] : [], has_more: false });
    }
    if (url.pathname === '/v1/prices/price_plus') {
      return Response.json({ active: true, currency: 'usd', unit_amount: 1500, recurring: { interval: 'month', interval_count: 1 }, livemode: false });
    }
    if (url.pathname === '/v1/checkout/sessions') {
      checkouts++;
      assert.equal(options.body.get('mode'), 'subscription');
      assert.equal(options.body.get('customer'), 'cus_A');
      assert.equal(options.body.get('subscription_data[trial_period_days]'), '7');
      assert.match(options.body.get('success_url'), /session_id=\{CHECKOUT_SESSION_ID\}$/);
      assert.match(options.headers['Idempotency-Key'], /^planpulse-checkout-v2-/);
      assert.equal(options.body.get('allowed_payment_method_types[0]'), 'card');
      assert.equal(options.body.has('payment_method_types[0]'), false);
      existingCheckout = { id: 'cs_test_A', url: 'https://checkout.stripe.com/c/pay/test', livemode: false, status: 'open' };
      return Response.json(existingCheckout);
    }
    if (url.pathname === '/v1/checkout/sessions/cs_test_A') return Response.json(existingCheckout);
    if (url.pathname === '/v1/billing_portal/sessions') {
      assert.equal(options.body.get('customer'), 'cus_A');
      return Response.json({ url: 'https://billing.stripe.com/p/session/test', livemode: false });
    }
    assert.fail('Unexpected provider request: ' + url.pathname);
  });

  const request = (path, { body, session, source = origin, headers = {} } = {}) => worker.fetch(new Request(origin + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: source, ...(session ? { Cookie: session } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env);
  const getCookie = (response, name) => {
    const header = response.headers.getSetCookie().find(value => value.startsWith(name + '='));
    assert.match(header, /Secure; HttpOnly; SameSite=Lax/);
    return header.split(';')[0];
  };
  async function signIn() {
    const start = await request('auth/login?tier=plus');
    assert.equal(start.status, 303);
    const location = new URL(start.headers.get('Location'));
    assert.equal(location.origin, 'https://accounts.google.com');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const cookie = getCookie(start, '__Host-planpulse-login');
    const denied = await request('auth/callback?code=good&state=incorrect', { session: cookie });
    assert.match(denied.headers.get('Location'), /login=retry/);
    const state = location.searchParams.get('state');
    const end = await request('auth/callback?code=good&state=' + state, { session: cookie });
    assert.equal(end.headers.get('Location'), origin + '/member/?tier=plus');
    return getCookie(end, '__Host-planpulse-session');
  }
  async function webhook(type, valid = true, live = false) {
    const raw = JSON.stringify({ type, livemode: live, data: { object: { customer: 'cus_A' } } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', valid ? env.STRIPE_WEBHOOK_SECRET : 'bad')
      .update(timestamp + '.' + raw).digest('hex');
    return request('stripe/webhook', {
      body: raw, source: 'https://stripe.com', headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` }
    });
  }
  async function data(path, options, expected = 200) {
    const response = await request(path, options);
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return result;
  }

  await data('health');
  await data('dashboard', {}, 401);
  const session = await signIn();
  let dashboard = await data('dashboard', { session });
  assert.equal(dashboard.account.status, 'none');
  const freePlanner = 'planner?month=2026-11';
  await data(freePlanner, {}, 401);
  const freeResult = await data(freePlanner, { session, body: {
    action: 'add', day: '2026-11-25', title: 'Free planner task'
  } });
  assert.deepEqual(freeResult.activities, []);
  assert.equal((await data(freePlanner, { session })).tasks[0].title, 'Free planner task');
  await data(freePlanner, { session, body: { action: 'delete', id: freeResult.tasks[0].id } });
  const preferences = {
    tracks: [
      { key: 'meal', goal: 'Quick dinners', preference: 'Vegetarian' },
      { key: 'study', goal: 'Practice a language', preference: '20 minutes' }
    ], days: [2, 6]
  };
  await data('preferences', { session, body: preferences }, 403);
  await data('checkout', { session, source: 'https://example.com', body: { tier: 'plus' } }, 403);
  const first = await data('checkout', { session, body: { tier: 'plus' } });
  const second = await data('checkout', { session, body: { tier: 'plus' } });
  assert.equal(first.url, second.url);
  assert.equal(checkouts, 1);

  assert.equal((await webhook('checkout.session.completed', false)).status, 400);
  assert.equal((await webhook('checkout.session.completed', true, true)).status, 400);
  stripeStatus = 'trialing';
  dashboard = await data('dashboard?session_id=cs_test_A', { session });
  assert.equal(dashboard.account.tier, 'plus');
  assert.equal(dashboard.account.status, 'trialing');
  assert.equal(dashboard.plan, null);
  await data('checkout', { session, body: { tier: 'plus' } }, 409);
  await data('preferences', { session, body: { ...preferences, days: [7] } }, 400);
  assert.deepEqual(await data('preferences', { session, body: preferences }), { effectiveWeek: '2026-11-23' });
  dashboard = await data('dashboard', { session });
  assert.equal(dashboard.plan.length, 4);
  assert.deepEqual(dashboard.plan.map(activity => activity.date), ['2026-11-25', '2026-11-25', '2026-11-29', '2026-11-29']);
  const planner = 'planner?month=2026-11&weekly=1';
  assert.equal((await data(planner, { session })).activities.length, 4);
  await data(planner, { session, body: { action: 'add', day: '2026-11-31', title: 'Invalid day' } }, 400);
  const { tasks: [task] } = await data(planner, { session, body: {
    action: 'add', day: '2026-11-25', title: 'Prep lunches'
  } });
  assert.equal(task.title, 'Prep lunches');
  await data(planner, { session, body: { action: 'complete', id: task.id, done: true } });
  assert.equal((await data(planner, { session })).tasks[0].done, 1);
  await data(planner, { session, body: { action: 'delete', id: task.id } });
  assert.deepEqual((await data(planner, { session })).tasks, []);
  const activity = dashboard.plan[0].id;
  const completion = { week: dashboard.week, activity, done: true };
  await data('progress', { session, body: completion });
  await data('progress', { session, body: completion });
  await data('progress', { session, body: { ...completion, activity: 'arbitrary-activity' } }, 404);
  let rewards = await data('rewards', { session });
  assert.equal(rewards.personal.points, 0);
  assert.equal(rewards.profile, null);
  assert.deepEqual(rewards.leaderboard, []);
  await data('rewards/profile', { session, body: { enabled: true, firstName: 'first@example.com', state: 'NY' } }, 400);
  rewards = await data('rewards/profile', { session, body: { enabled: true, firstName: 'Alex', state: 'NY' } });
  assert.deepEqual(rewards.leaderboard, [{ firstName: 'Alex', state: 'NY', activities: 1, points: 0 }]);
  rewards = await data('rewards/profile', { session, body: { enabled: false } });
  assert.equal(rewards.profile, null);
  assert.deepEqual(rewards.leaderboard, []);
  await data('reminders', { session, body: { time: '24:00' } }, 400);
  await data('reminders', { session, body: { time: '12:00' } });
  dashboard = await data('dashboard', { session });
  assert.deepEqual(dashboard.completed, [activity]);
  assert.equal(dashboard.notices.filter(notice => notice.id === 'daily-2026-11-25').length, 1);
  assert.match(dashboard.notices.find(notice => notice.id === 'daily-2026-11-25').message, /Today on your schedule/);
  await data('notifications/read', { session, body: { before: Math.floor(Date.now() / 1000) } });
  assert.ok((await data('dashboard', { session })).notices.every(notice => notice.read === 1));

  assert.deepEqual(await data('preferences', { session, body: { ...preferences, days: [0, 4] } }), { effectiveWeek: '2026-11-30' });
  t.mock.timers.setTime(new Date('2026-11-29T18:00:00Z').valueOf());
  await runSchedule(env, new Date());
  await runSchedule(env, new Date());
  dashboard = await data('dashboard', { session });
  assert.equal(dashboard.week, '2026-11-30');
  assert.equal(dashboard.history.length, 2);
  assert.deepEqual(dashboard.plan.map(item => item.date), ['2026-11-30', '2026-11-30', '2026-12-04', '2026-12-04']);
  assert.equal(dashboard.notices.filter(item => item.id === 'published-2026-11-30').length, 1);
  assert.equal(dashboard.notices.filter(item => item.id === 'daily-2026-11-29').length, 1);
  assert.deepEqual((await data('dashboard?week=2026-11-23', { session })).completed, [activity]);
  assert.equal((await data('billing', { session, body: {} })).url, 'https://billing.stripe.com/p/session/test');

  user = 'other';
  const other = await signIn();
  await data('progress', { session: other, body: completion }, 403);
  const otherDashboard = await data('dashboard?week=2026-11-23', { session: other });
  assert.equal(otherDashboard.plan, undefined);
  assert.doesNotMatch(JSON.stringify(otherDashboard), /first@example.com/);

  const november = 'planner?month=2026-11';
  const december = 'planner?month=2026-12';
  const repeat = { action: 'add', day: '2026-11-25', title: 'Weekly prep', repeats: true };
  await data(november, { session: other, body: repeat }, 403);
  await data(november, { session, body: repeat });
  const { tasks: [occurrence] } = await data(december, { session });
  assert.equal(occurrence.day, '2026-12-02');
  await data(december, { session, body: { action: 'complete', id: occurrence.id, day: occurrence.day, done: true } });
  const repeated = (await data(december, { session })).tasks;
  assert.equal(repeated[0].done, true);
  assert.equal(repeated[1].done, false);
  assert.deepEqual((await data(december + '&weekly=1', { session })).recap, {
    week: '2026-11-30', completed: 0, total: 4
  });

  stripePrice = 'price_all';
  assert.equal((await webhook('customer.subscription.updated')).status, 200);
  const ownerCalendar = november + '&owner=mine';
  const share = { action: 'share', email: 'other@example.com', permission: 'view' };
  await data(ownerCalendar, { session, body: share });
  const { incoming: [invitation], tasks: personal } = await data(november, { session: other });
  assert.deepEqual(personal, []);
  const sharedCalendar = november + '&owner=' + invitation.id;
  const sharedTask = { action: 'add', day: '2026-11-26', title: 'Shared plans' };
  await data(sharedCalendar, { session: other, body: sharedTask }, 403);
  await data(ownerCalendar, { session, body: { ...share, permission: 'edit' } });
  await data(sharedCalendar, { session: other, body: sharedTask });
  assert.equal((await data(ownerCalendar, { session })).tasks[0].title, sharedTask.title);
  assert.equal((await data(november, { session })).tasks.some(task => task.title === sharedTask.title), false);
  await data(ownerCalendar, { session, body: { action: 'revoke', email: share.email } });
  await data(sharedCalendar, { session: other }, 403);

  await data('calendar-link', { body: { action: 'create' } }, 401);
  const { url: feedUrl } = await data('calendar-link', { session, body: { action: 'create' } });
  const feedPath = new URL(feedUrl).pathname.slice('/api/'.length);
  const feedResponse = await request(feedPath);
  assert.equal(feedResponse.status, 200);
  const ics = await feedResponse.text();
  assert.match(ics, /SUMMARY:Weekly prep\r\nRRULE:FREQ=WEEKLY/);
  assert.doesNotMatch(ics, /Shared plans/);
  await data('calendar-link', { session, body: { action: 'revoke' } });
  await data(feedPath, {}, 404);

  stripeStatus = 'canceled';
  assert.equal((await webhook('customer.subscription.deleted')).status, 200);
  await data('progress', { session, body: completion }, 403);
  assert.equal((await data('dashboard', { session })).account.status, 'none');
  assert.equal((await request('auth/logout', { session, body: '' })).status, 303);
  await data('dashboard', { session }, 401);
});

test('Sunday release and Saturday cutoff follow Eastern civil time in summer and winter', () => {
  for (const [instant, published, next, activityWeek] of [
    ['2026-11-28T16:59:00Z', '2026-11-23', '2026-11-30', '2026-11-23'],
    ['2026-11-28T17:00:00Z', '2026-11-23', '2026-12-07', '2026-11-23'],
    ['2026-11-29T11:59:00Z', '2026-11-23', '2026-12-07', '2026-11-23'],
    ['2026-11-29T12:00:00Z', '2026-11-30', '2026-12-07', '2026-11-23'],
    ['2026-07-05T10:59:00Z', '2026-06-29', '2026-07-13', '2026-06-29'],
    ['2026-07-05T11:00:00Z', '2026-07-06', '2026-07-13', '2026-06-29'],
    ['2027-01-01T17:00:00Z', '2026-12-28', '2027-01-04', '2026-12-28']
  ]) {
    const clock = scheduleClock(new Date(instant));
    assert.equal(clock.week, published);
    assert.equal(clock.nextPreferencesWeek, next);
    assert.equal(clock.activityWeek, activityWeek);
  }
  assert.equal(validatePreferences({ tracks: [null], days: [0] }, 'starter'), null);
});

test('weekly points accumulate only at milestone thresholds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 10, 11].map(count => rewardLevel(count).points),
    [0, 0, 0, 20, 20, 50, 50, 120, 120]);
});
