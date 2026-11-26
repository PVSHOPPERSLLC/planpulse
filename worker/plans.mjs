const eastern = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function shiftDate(date, days) {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function scheduleClock(now = new Date()) {
  const { year, month, day, hour, minute } = Object.fromEntries(
    eastern.formatToParts(now).map(part => [part.type, part.value])
  );
  const today = `${year}-${month}-${day}`;
  const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
  const time = `${hour}:${minute}`;
  const daysSinceSunday = weekday || (time < '07:00' ? 7 : 0);
  const week = shiftDate(today, 1 - daysSinceSunday);
  const afterCutoff = weekday === 6 && time >= '12:00' || weekday === 0 && time < '07:00';
  const activityWeek = shiftDate(today, -((weekday + 6) % 7));
  return { today, time, week, activityWeek, nextPreferencesWeek: shiftDate(week, afterCutoff ? 14 : 7) };
}

export const TIERS = {
  starter: { name: 'Starter', price: 900, tracks: 1, trial: 0, priceVariable: 'STRIPE_PRICE_STARTER' },
  plus: { name: 'Plus', price: 1500, tracks: 2, trial: 7, priceVariable: 'STRIPE_PRICE_PLUS' },
  all: { name: 'All-Access', price: 1900, tracks: 3, trial: 7, priceVariable: 'STRIPE_PRICE_ALL' }
};

export const TRACKS = {
  meal: {
    name: 'Meal',
    goals: ['Quick dinners', 'Plant-forward meals', 'Higher-protein meals'],
    options: {
      'No preference': [
        ['Lemon chicken and quinoa', 'Salmon with potatoes and greens', 'Turkey and spinach tacos', 'Egg and vegetable rice bowls'],
        ['Black bean and avocado tostadas', 'Roasted vegetable couscous', 'Mushroom and white bean soup', 'Lentil and tomato pasta'],
        ['Chicken and edamame bowls', 'Greek yogurt and turkey flatbread', 'Salmon and lentil salad', 'Tofu and chickpea skillet']
      ],
      Vegetarian: [
        ['Spinach and feta wrap', 'Chickpea and cucumber bowls', 'Tomato and white bean toast', 'Vegetable omelet and greens'],
        ['Roasted cauliflower and tahini bowls', 'Mushroom and lentil tacos', 'Chickpea and tomato stew', 'Tofu and broccoli rice bowls'],
        ['Edamame and tofu bowls', 'Black bean and quinoa salad', 'Egg, hummus and greens plate', 'Cottage cheese and chickpea bowls']
      ],
      'Gluten-free': [
        ['Lemon chicken and brown rice', 'Baked salmon and sweet potato', 'Egg and vegetable potato hash', 'Corn tortilla black bean tacos'],
        ['Chickpea and quinoa salad', 'Roasted squash and white beans', 'Lentil and vegetable soup', 'Broccoli and tofu rice bowls'],
        ['Turkey and quinoa bowls', 'Tofu and edamame rice bowls', 'Salmon and lentil salad', 'Chicken and black bean bowls']
      ],
      'Dairy-free': [
        ['Lemon chicken and quinoa', 'Salmon and vegetable rice bowls', 'Black bean and avocado tacos', 'Turkey and spinach skillet'],
        ['Roasted cauliflower and chickpeas', 'Lentil and vegetable soup', 'White bean tomato toast', 'Mushroom and tofu rice bowls'],
        ['Chicken and edamame bowls', 'Black bean and quinoa salad', 'Tofu and chickpea skillet', 'Tuna and white bean salad']
      ]
    },
    detail: 'Use ingredients and portions that work for you. Check labels and preparation for any dietary restrictions.'
  },
  fitness: {
    name: 'Fitness',
    goals: ['Build strength', 'Improve conditioning', 'Build a movement habit'],
    options: {
      'Bodyweight only': [
        ['Chair squats and wall push-ups', 'Step-ups and a supported plank', 'Hip bridges and heel raises', 'Controlled reverse lunges and bird dogs'],
        ['Brisk walk with easy intervals', 'Low-impact step and reach circuit', 'Easy cycling or a walk', 'Continuous low-impact movement'],
        ['Easy walk and mobility', 'Gentle lower-body movements', 'Standing mobility and posture practice', 'Easy walk with optional stretches']
      ],
      Dumbbells: [
        ['Dumbbell squat and row practice', 'Supported dumbbell press and hinge', 'Light dumbbell carry and step-up', 'Dumbbell floor press and calf raises'],
        ['Low-impact bodyweight intervals', 'Light dumbbell circuit with rests', 'Brisk walk and easy mobility', 'Easy step-ups and a light carry'],
        ['Light dumbbell movements', 'Easy walk and a light carry', 'Mobility and supported rows', 'Comfortable squat and press practice']
      ],
      'Full gym': [
        ['Leg press and seated row practice', 'Chest press and light hip hinge', 'Lat pulldown and step-up practice', 'Cable row and split squat practice'],
        ['Comfortable stationary bike intervals', 'Easy elliptical and mobility', 'Brisk treadmill walk with rests', 'Moderate cycling and cool-down'],
        ['Easy treadmill walk', 'Gentle bicycle and mobility', 'Light machine familiarization', 'Easy elliptical and stretching']
      ]
    },
    detail: 'Choose a comfortable effort and allow recovery between demanding sessions.'
  },
  study: {
    name: 'Study',
    goals: ['Prepare for an exam', 'Practice a language', 'Build technical skills'],
    options: {
      '20 minutes': [
        ['Recall five key ideas', 'Solve one practice problem', 'Review recent mistakes', 'Make a short self-quiz'],
        ['Review five useful phrases', 'Listen and repeat a short clip', 'Record a short introduction', 'Write three sentences'],
        ['Read a short worked example', 'Recreate one small example', 'Debug one small issue', 'Summarize a useful command']
      ],
      '40 minutes': [
        ['Pair a concept review with practice questions', 'Try a timed problem set', 'Review errors and retry missed questions', 'Create and take a topic quiz'],
        ['Practice a short conversation', 'Listen and summarize a clip', 'Record a description and review it', 'Read a short passage and discuss it'],
        ['Adapt a worked example', 'Implement one small feature', 'Debug and explain a failing test', 'Write notes and extend an exercise']
      ],
      '60 minutes': [
        ['Practice a timed exam section', 'Review a weak topic and solve mixed questions', 'Take a mock quiz and analyze mistakes', 'Write a summary and test your recall'],
        ['Listen to a longer clip and give an oral summary', 'Practice a conversation and review feedback', 'Read and rewrite a passage in your own words', 'Record a story and revise it'],
        ['Build a small project increment', 'Test and debug a project feature', 'Compare two ways to solve a problem', 'Document an exercise and build on it']
      ]
    },
    detail: 'Use your own course materials or a practice resource you already trust.'
  }
};

export function validatePreferences(input, tier) {
  if (!input || !Array.isArray(input.tracks) || !Array.isArray(input.days)) return null;
  const unique = new Set(input.tracks.map(track => track?.key));
  if (unique.size !== input.tracks.length || unique.size !== TIERS[tier].tracks) return null;
  const days = [...new Set(input.days)].sort((a, b) => a - b);
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return null;
  const tracks = [];
  for (const track of input.tracks) {
    if (!track || !Object.hasOwn(TRACKS, track.key)) return null;
    const model = TRACKS[track.key];
    if (!model.goals.includes(track.goal) || !Object.hasOwn(model.options, track.preference)) return null;
    tracks.push({ key: track.key, goal: track.goal, preference: track.preference });
  }
  return { tracks, days };
}

export function buildPlan(settings, tier, week) {
  const weekIndex = Math.floor(Date.parse(week + 'T00:00:00Z') / (7 * 86_400_000));
  return settings.tracks.slice(0, TIERS[tier].tracks).flatMap(track => {
    const model = TRACKS[track.key];
    const choices = model.options[track.preference][model.goals.indexOf(track.goal)];
    return settings.days.map((day, index) => ({
      id: `${track.key}-${day}`,
      track: track.key,
      date: shiftDate(week, day),
      title: choices[(weekIndex + index) % choices.length],
      detail: track.key === 'study' ? `${track.preference} · ${model.detail}` : model.detail
    }));
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export const TRACK_OPTIONS = Object.fromEntries(Object.entries(TRACKS).map(([key, value]) => [
  key, { name: value.name, goals: value.goals, preferences: Object.keys(value.options) }
]));
