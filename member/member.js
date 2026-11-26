const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const weekdayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const notificationFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const isEntitled = data => ['active', 'trialing'].includes(data?.account.status);
const dateAt = date => new Date(date + 'T00:00:00Z');
const formatDate = date => dateFormat.format(dateAt(date));

let model;
let renderVersion = 0;
const pendingActivity = new Set();

function el(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function status(message = '', error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}

async function api(path, payload) {
  const response = await fetch('/api/' + path, {
    credentials: 'same-origin',
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (!response.ok || !result) {
    const error = new Error(result?.error || 'The member service is temporarily unavailable.');
    error.status = result ? response.status : 503;
    throw error;
  }
  return result;
}

async function action(button, operation) {
  button.disabled = true;
  try {
    status();
    await operation();
  } catch (error) {
    status(error.message || 'Please try again.', true);
  } finally {
    button.disabled = false;
  }
}

function accountView(data) {
  $('sign-in').hidden = Boolean(data);
  $('account-actions').hidden = !data;
  const free = Boolean(data) && !isEntitled(data);
  const showMemberships = free && $('show-memberships').getAttribute('aria-expanded') === 'true';
  $('billing-view').hidden = !showMemberships;
  $('free-workspace').hidden = !free;
  $('workspace').hidden = !data || !isEntitled(data);
  if (!data || !isEntitled(data)) $('rewards-panel').hidden = true;
  if (data) $('account-email').textContent = data.account.email;
}

function goToBillingPortal(button) {
  return action(button, async () => {
    const result = await api('billing', {});
    location.assign(result.url);
  });
}

function showOffers(data) {
  $('manage-billing').hidden = !data.account.hasBilling;
  const blocked = ['past_due', 'unpaid', 'paused', 'incomplete'].includes(data.account.status);
  $('tiers').replaceChildren(...Object.entries(data.tiers).map(([id, tier]) => {
    const selected = query.get('tier') === id;
    const card = el('article', undefined, 'panel tier' + (selected ? ' selected' : ''));
    const amount = el('p', '$' + tier.price / 100, 'price');
    amount.append(el('small', ' / month'));
    const units = el('p', tier.tracks === 1 ? '1 plan type per week' : tier.tracks + ' plan types per week');
    const button = el('button', 'Choose ' + tier.name, 'button ' + (selected ? 'primary' : 'secondary'));
    button.type = 'button';
    button.disabled = blocked || data.billingUnavailable;
    button.addEventListener('click', () => action(button, async () => {
      const result = await api('checkout', { tier: id });
      location.assign(result.url);
    }));
    card.append(el('h2', tier.name), amount, units);
    if (tier.trial) card.append(el('p', '7-day trial for eligible new subscribers', 'fine-print'));
    card.append(button);
    return card;
  }));
  if (data.billingUnavailable) status('Billing is temporarily unavailable. You can still use your personal planner.', true);
  else if (blocked) status('Open Manage billing to resolve your current subscription before starting another.');
}

function makeSelect(values, value) {
  const select = el('select');
  for (const label of values) select.add(new Option(label, label));
  if (values.includes(value)) select.value = value;
  return select;
}

function showPreferences(data) {
  const count = data.tiers[data.account.tier].tracks;
  const previous = data.preferences;
  $('preferences-title').textContent = previous ? 'Plan preferences' : 'Set up your first plan';
  $('preferences-detail').textContent = previous
    ? `Changes apply to the week of ${formatDate(data.nextPreferencesWeek)}. Your saved settings apply from ${formatDate(data.preferencesWeek)}.`
    : 'Choose what you want to work on and when you’re available. Your first plan will appear as soon as you save.';
  $('track-legend').textContent = `Choose ${count} ${count === 1 ? 'plan type' : 'plan types'}`;
  $('save-preferences').textContent = previous ? 'Save plan preferences' : 'Create my first plan';
  $('tracks').replaceChildren(...Object.entries(data.tracks).map(([key, track], index) => {
    const saved = previous?.tracks.find(setting => setting.key === key);
    const row = el('div', undefined, 'track');
    row.dataset.track = key;
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.checked = count === 3 || Boolean(saved) || (!previous && index < count);
    enabled.disabled = count === 3;
    const checkLabel = el('label', undefined, 'check-line');
    checkLabel.append(enabled, track.name);
    const detail = el('div', undefined, 'track-prefs');
    detail.hidden = !enabled.checked;
    const goal = el('label', 'Goal');
    goal.append(makeSelect(track.goals, saved?.goal));
    const preference = el('label', 'Preference');
    preference.append(makeSelect(track.preferences, saved?.preference));
    detail.append(goal, preference);
    enabled.addEventListener('change', () => { detail.hidden = !enabled.checked; });
    row.append(checkLabel, detail);
    return row;
  }));
  $('days').replaceChildren(...weekdays.map((day, index) => {
    const input = el('input');
    input.type = 'checkbox';
    input.value = String(index);
    input.checked = previous ? previous.days.includes(index) : index < 5;
    const label = el('label', undefined, 'check-line');
    label.append(input, day);
    return label;
  }));
}

let selectedScheduleWeek;
let selectedScheduleDay = '';
const easternDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function progressLabel(data) {
  const completed = new Set(data.completed);
  $('progress').textContent = `${completed.size} of ${data.plan.length} complete · ${data.plan.length - completed.size} left`;
  $('week-meter').max = Math.max(1, data.plan.length);
  $('week-meter').value = completed.size;
  for (const button of $('week-days').querySelectorAll('[data-date]')) {
    const activities = data.plan.filter(activity => activity.date === button.dataset.date);
    const done = activities.filter(activity => completed.has(activity.id)).length;
    button.querySelector('small').textContent = activities.length ? `${done}/${activities.length}` : 'Rest';
  }
}

function selectScheduleDay(day) {
  selectedScheduleDay = day;
  for (const button of $('week-days').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String((button.dataset.date ?? '') === day));
  }
  for (const group of $('schedule').querySelectorAll('[data-date]')) {
    group.hidden = Boolean(day && day !== group.dataset.date);
  }
  $('rest-day').hidden = !day || [...$('schedule').querySelectorAll('[data-date]')].some(group => group.dataset.date === day);
}

function showSchedule(data) {
  $('schedule-panel').hidden = !data.plan;
  if (!data.plan) return;
  $('schedule-title').textContent = `Week of ${formatDate(data.week)}`;
  if (selectedScheduleWeek !== data.week) {
    selectedScheduleWeek = data.week;
    selectedScheduleDay = '';
  }
  const today = easternDate.format(new Date());
  const allDays = el('button', 'All days', 'week-day');
  allDays.type = 'button';
  allDays.addEventListener('click', () => selectScheduleDay(''));
  $('week-days').replaceChildren(allDays, ...Array.from({ length: 7 }, (_, index) => {
    const date = dateAt(data.week);
    date.setUTCDate(date.getUTCDate() + index);
    const key = date.toISOString().slice(0, 10);
    const button = el('button', undefined, 'week-day');
    button.type = 'button';
    button.dataset.date = key;
    button.append(el('strong', weekdays[index]), el('small'));
    button.setAttribute('aria-label', weekdayFormat.format(date));
    if (key === today) button.setAttribute('aria-current', 'date');
    button.addEventListener('click', () => selectScheduleDay(key));
    return button;
  }));
  $('history').replaceChildren(...data.history.map(week =>
    new Option(formatDate(week), week, false, week === data.week)
  ));
  const byDay = new Map();
  for (const activity of data.plan) {
    if (!byDay.has(activity.date)) byDay.set(activity.date, []);
    byDay.get(activity.date).push(activity);
  }
  $('schedule').replaceChildren(...Array.from(byDay, ([day, activities]) => {
    const section = el('section', undefined, 'schedule-day');
    section.dataset.date = day;
    section.append(el('h3', day === today ? 'Today · ' + weekdayFormat.format(dateAt(day)) : weekdayFormat.format(dateAt(day))));
    for (const activity of activities) {
      const check = el('input');
      check.type = 'checkbox';
      check.checked = data.completed.includes(activity.id);
      const activityKey = JSON.stringify([data.week, activity.id]);
      check.disabled = pendingActivity.has(activityKey);
      check.addEventListener('change', async () => {
        const done = check.checked;
        pendingActivity.add(activityKey);
        check.disabled = true;
        try {
          await api('progress', { week: data.week, activity: activity.id, done });
          for (const view of new Set([data, model])) {
            if (view?.week !== data.week) continue;
            view.completed = view.completed.filter(id => id !== activity.id);
            if (done) view.completed.push(activity.id);
          }
          if (model?.week === data.week) progressLabel(model);
          if (done && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
            check.closest('.activity').animate([{ transform: 'scale(.98)' }, { transform: 'scale(1.012)' }, { transform: 'scale(1)' }], { duration: 260 });
          }
          refreshRewards();
        } catch (error) {
          check.checked = !done;
          status(error.message, true);
        } finally {
          pendingActivity.delete(activityKey);
          check.disabled = false;
          if (!check.isConnected && model?.week === data.week) showSchedule(model);
        }
      });
      const text = el('span');
      text.append(el('strong', activity.title), el('small', data.tracks[activity.track].name + ' · ' + activity.detail));
      const label = el('label', undefined, 'activity');
      label.append(check, text);
      section.append(label);
    }
    return section;
  }));
  const rest = el('p', 'Rest day. There are no activities scheduled for this day.');
  rest.id = 'rest-day';
  $('schedule').append(rest);
  progressLabel(data);
  selectScheduleDay(selectedScheduleDay);
}

function showNotices(data) {
  const unread = data.notices.filter(item => !item.read).length;
  $('mark-read').hidden = !unread;
  $('notifications-link').textContent = unread ? `Notifications (${unread})` : 'Notifications';
  if (!data.notices.length) {
    $('notices').replaceChildren(el('li', 'Your plan updates and reminders will appear here.'));
    return;
  }
  $('notices').replaceChildren(...data.notices.map(notice => {
    const item = el('li', notice.message, notice.read ? '' : 'unread');
    const time = el('small', notificationFormat.format(new Date(notice.created * 1000)) + ' ET');
    item.append(time);
    return item;
  }));
}

function showReminderSettings(data) {
  $('reminder-enabled').checked = Boolean(data.reminderTime);
  $('reminder-time').value = data.reminderTime ?? '18:00';
  $('reminder-time').disabled = !data.reminderTime;
}

async function load({ week = null, notificationsOnly = false } = {}) {
  const version = notificationsOnly ? renderVersion : ++renderVersion;
  try {
    const params = new URLSearchParams();
    if (week) params.set('week', week);
    if (!model || !isEntitled(model)) {
      const session = query.get('session_id');
      if (session) params.set('session_id', session);
    }
    const data = await api('dashboard' + (params.size ? '?' + params : ''));
    if (version !== renderVersion) return;
    if (notificationsOnly && isEntitled(data) && isEntitled(model)) {
      model.notices = data.notices;
      showNotices(model);
      return;
    }
    model = data;
    accountView(data);
    const planner = $('planner');
    const free = !isEntitled(data);
    const slot = $(free ? 'free-planner-slot' : 'paid-planner-slot');
    if (planner.parentElement !== slot) slot.append(planner);
    if (free) {
      if (data.account.hasBilling || data.tiers[query.get('tier')]) setMembershipVisibility(true);
      if (!planner.open) planner.open = true;
      else updatePlanner();
      if (!$('billing-view').hidden) showOffers(data);
      return;
    }
    if (planner.open) updatePlanner();
    $('membership').textContent = data.tiers[data.account.tier].name + (data.account.status === 'trialing' ? ' · Trial active' : ' · Subscription active');
    showPreferences(data);
    if (!data.plan || $('schedule-panel').hidden) $('preferences-panel').open = !data.plan;
    showSchedule(data);
    showNotices(data);
    showReminderSettings(data);
    refreshRewards(true);
  } catch (error) {
    if (version !== renderVersion) return;
    if (error.status !== 401) throw error;
    model = null;
    accountView(null);
    const tier = query.get('tier');
    if (tier) $('login-link').href = '/api/auth/login?tier=' + encodeURIComponent(tier);
  }
}

function setMembershipVisibility(visible) {
  const button = $('show-memberships');
  button.setAttribute('aria-expanded', String(visible));
  button.textContent = visible ? 'Hide memberships' : 'View memberships';
  $('billing-view').hidden = !visible;
}

$('show-memberships').addEventListener('click', () => {
  const visible = $('billing-view').hidden;
  setMembershipVisibility(visible);
  if (visible) showOffers(model);
});

$('manage-billing').addEventListener('click', event => goToBillingPortal(event.currentTarget));
$('member-billing').addEventListener('click', event => goToBillingPortal(event.currentTarget));
$('history').addEventListener('change', async event => {
  try { await load({ week: event.target.value }); }
  catch (error) { status(error.message, true); }
});
$('preferences-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('save-preferences'), async () => {
    const tracks = [...$('tracks').querySelectorAll('[data-track]')].flatMap(row => {
      if (!row.querySelector('input').checked) return [];
      const [goal, preference] = row.querySelectorAll('select');
      return [{ key: row.dataset.track, goal: goal.value, preference: preference.value }];
    });
    const days = [...$('days').querySelectorAll(':checked')].map(input => Number(input.value));
    const result = await api('preferences', { tracks, days });
    await load();
    status('Preferences saved for the week of ' + formatDate(result.effectiveWeek) + '.');
  });
});
$('reminder-enabled').addEventListener('change', event => {
  $('reminder-time').disabled = !event.target.checked;
});
$('reminder-form').addEventListener('submit', event => {
  event.preventDefault();
  action(event.submitter, async () => {
    const { time } = await api('reminders', { time: $('reminder-enabled').checked ? $('reminder-time').value : null });
    model.reminderTime = time;
    status(time ? 'Reminder preference saved.' : 'Activity reminders are off.');
    await load({ week: model.week, notificationsOnly: true });
  });
});
$('mark-read').addEventListener('click', event => action(event.currentTarget, async () => {
  await api('notifications/read', { before: Math.max(...model.notices.map(notice => notice.created)) });
  await load({ week: model.week, notificationsOnly: true });
}));

const stateCodes = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
for (const state of stateCodes) $('leaderboard-state').add(new Option(state, state));

let rewardsRequest = 0;
let previousReward;
async function refreshRewards(updateForm = false) {
  const request = ++rewardsRequest;
  try {
    const data = await api('rewards');
    if (request !== rewardsRequest || !isEntitled(model)) return;
    const { points, activities, level } = data.personal;
    const next = [3, 5, 10].find(milestone => activities < milestone);
    $('reward-summary').textContent = level + ' · ' + points + ' points this week';
    $('reward-meter').value = points;
    $('reward-next').textContent = next ? `${next - activities} more ${next - activities === 1 ? 'activity' : 'activities'} to the next milestone.` : 'All weekly milestones reached.';
    if (previousReward?.week === data.week && points > previousReward.points &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      $('reward-card').animate([
        { transform: 'scale(.99)', boxShadow: '0 0 0 0 #7855e566' },
        { transform: 'scale(1.01)', boxShadow: '0 0 0 8px #7855e500' },
        { transform: 'scale(1)' }
      ], { duration: 450 });
    }
    previousReward = { week: data.week, points };
    $('leaderboard-list').replaceChildren(...data.leaderboard.map(entry =>
      el('li', entry.firstName + ' · ' + entry.state + ' · ' + entry.activities + ' activities · ' + entry.points + ' points')
    ));
    $('leaderboard-empty').hidden = data.leaderboard.length > 0;
    if (updateForm) {
      $('leaderboard-enabled').checked = Boolean(data.profile);
      $('leaderboard-fields').hidden = !data.profile;
      $('leaderboard-name').value = data.profile?.firstName ?? '';
      $('leaderboard-state').value = data.profile?.state ?? '';
    }
    $('rewards-panel').hidden = false;
  } catch {
    if (request === rewardsRequest) $('rewards-panel').hidden = true;
  }
}

$('leaderboard-enabled').addEventListener('change', event => {
  $('leaderboard-fields').hidden = !event.target.checked;
});
$('leaderboard-form').addEventListener('submit', event => {
  event.preventDefault();
  action(event.submitter, async () => {
    const enabled = $('leaderboard-enabled').checked;
    await api('rewards/profile', {
      enabled, firstName: $('leaderboard-name').value, state: $('leaderboard-state').value
    });
    await refreshRewards(true);
    status(enabled ? 'Leaderboard sharing enabled.' : 'Your leaderboard profile is private.');
  });
});

async function start() {
  status();
  try {
    await load();
    if (query.get('login') === 'retry') status('Sign-in expired or was canceled. Try again.', true);
    if (query.get('billing') === 'return' && model) {
      for (let attempt = 0; attempt < 3 && !isEntitled(model); attempt++) {
        status('Checking your subscription with Stripe…');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await load();
        if (!model) break;
      }
      if (model && isEntitled(model)) status('Your subscription is ready.');
      else if (model) status('Stripe is still confirming your subscription. Refresh shortly before trying another checkout.');
    }
  } catch (error) {
    status(error.message, true);
  }
}
start();
setInterval(() => {
  if (!document.hidden && model && isEntitled(model)) {
    refreshRewards();
    load({ week: model.week, notificationsOnly: true }).catch(() => {});
  }
}, 60_000);

let plannerDate = easternDate.format(new Date());
let plannerVersion = 0;
let plannerOwner = '';
let plannerData = null;
const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function renderPlanner() {
  const calendars = [new Option('Personal planner', '')];
  if (plannerData?.canShare || plannerOwner === 'mine') calendars.push(new Option('My shared planner', 'mine'));
  for (const guest of plannerData?.incoming ?? []) calendars.push(new Option('Shared by ' + guest.email, guest.id));
  if (plannerOwner && !calendars.some(option => option.value === plannerOwner)) {
    calendars.push(new Option('Shared planner', plannerOwner));
  }
  $('planner-owner').replaceChildren(...calendars);
  $('planner-owner').value = plannerOwner;
  $('planner-picker').hidden = calendars.length < 2;
  $('planner-recap').hidden = !plannerData?.recap;
  if (plannerData?.recap) {
    const { week, completed, total } = plannerData.recap;
    $('planner-recap').textContent = 'Week of ' + formatDate(week) + ' · ' + completed + ' of ' + total + ' plan activities complete';
  }
  $('planner-form').hidden = plannerData?.canEdit !== true;
  $('planner-repeat-label').hidden = !plannerData?.canRepeat;
  $('planner-share').hidden = plannerOwner !== 'mine' || !plannerData?.canShare;
  $('planner-guests').replaceChildren(...(plannerData?.guests ?? []).map(guest => {
    const item = el('li', guest.email + (guest.permission === 'edit' ? ' · Can edit' : ' · Can view'));
    const revoke = el('button', 'Revoke', 'quiet');
    revoke.type = 'button';
    revoke.addEventListener('click', () => updatePlanner({ action: 'revoke', email: guest.email }));
    item.append(revoke);
    return item;
  }));
  const month = plannerDate.slice(0, 7);
  const first = dateAt(month + '-01');
  $('planner-month').textContent = monthFormat.format(first);
  $('planner-day').textContent = weekdayFormat.format(dateAt(plannerDate));
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => el('span', day));
  const blanks = Array.from({ length: (first.getUTCDay() + 6) % 7 }, () => el('span'));
  const end = new Date(first);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const tasks = plannerData?.tasks ?? [];
  const activities = plannerData?.activities ?? [];
  const occupied = new Set([...tasks.map(task => task.day), ...activities.map(activity => activity.date)]);
  const days = Array.from({ length: end.getUTCDate() }, (_, index) => {
    const key = month + '-' + String(index + 1).padStart(2, '0');
    const button = el('button', String(index + 1));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(key === plannerDate));
    button.setAttribute('aria-label', weekdayFormat.format(dateAt(key)) + (occupied.has(key) ? ', has activities' : ''));
    button.classList.toggle('has-items', occupied.has(key));
    button.addEventListener('click', () => {
      plannerDate = key;
      renderPlanner();
      $('planner-days').querySelector('[aria-pressed="true"]').focus();
    });
    return button;
  });
  $('planner-days').replaceChildren(...labels, ...blanks, ...days);
  const items = activities.filter(activity => activity.date === plannerDate)
    .map(activity => el('li', activity.title + ' · Weekly plan'));
  for (const task of tasks.filter(task => task.day === plannerDate)) {
    const item = el('li');
    const label = el('label');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = Boolean(task.done);
    check.disabled = !plannerData?.canEdit;
    check.addEventListener('change', () => updatePlanner({ action: 'complete', id: task.id, day: task.day, done: check.checked }));
    label.append(check, document.createTextNode(' ' + task.title + (task.repeats ? ' · Weekly' : '')));
    const remove = el('button', 'Remove', 'quiet');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove ' + task.title);
    remove.addEventListener('click', () => updatePlanner({ action: 'delete', id: task.id }));
    item.append(label);
    if (plannerData?.canEdit) {
      if (task.repeats) remove.textContent = 'Remove series';
      item.append(remove);
    }
    items.push(item);
  }
  $('planner-items').replaceChildren(...items);
  $('planner-add').disabled = !plannerData;
}

async function updatePlanner(payload) {
  const version = ++plannerVersion;
  const params = new URLSearchParams({ month: plannerDate.slice(0, 7) });
  if (plannerOwner) params.set('owner', plannerOwner);
  else if (isEntitled(model)) params.set('weekly', '1');
  const endpoint = 'planner?' + params;
  $('planner-form').inert = true;
  $('planner-share').inert = true;
  $('planner-items').inert = true;
  $('planner-status').textContent = payload ? 'Saving…' : 'Loading…';
  try {
    const result = await api(endpoint, payload);
    if (version !== plannerVersion) return false;
    plannerData = result;
    $('planner-status').textContent = '';
    renderPlanner();
    return true;
  } catch (error) {
    if (version === plannerVersion) {
      $('planner-status').textContent = error.message;
      renderPlanner();
    }
    return false;
  } finally {
    if (version === plannerVersion) {
      $('planner-form').inert = false;
      $('planner-share').inert = false;
      $('planner-items').inert = false;
    }
  }
}

$('planner').addEventListener('toggle', () => {
  if ($('planner').open && model) {
    renderPlanner();
    updatePlanner();
  }
});
for (const [id, offset] of [['planner-prev', -1], ['planner-next', 1]]) {
  $(id).addEventListener('click', () => {
    const first = dateAt(plannerDate.slice(0, 7) + '-01');
    first.setUTCMonth(first.getUTCMonth() + offset);
    plannerDate = first.toISOString().slice(0, 10);
    plannerData = null;
    renderPlanner();
    updatePlanner();
  });
}
$('planner-form').addEventListener('submit', async event => {
  event.preventDefault();
  const field = $('planner-title');
  if (await updatePlanner({ action: 'add', day: plannerDate, title: field.value, repeats: !$('planner-repeat-label').hidden && $('planner-repeat').checked })) field.value = '';
});

$('planner-owner').addEventListener('change', event => {
  plannerOwner = event.target.value;
  plannerData = null;
  renderPlanner();
  updatePlanner();
});
$('planner-share').addEventListener('submit', async event => {
  event.preventDefault();
  const field = $('planner-guest');
  if (await updatePlanner({ action: 'share', email: field.value, permission: $('planner-permission').value })) field.value = '';
});
