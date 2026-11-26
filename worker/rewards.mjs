const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));

export function sharedProfile(input) {
  if (input?.enabled === false) return false;
  if (input?.enabled !== true || typeof input.firstName !== 'string') return null;
  const firstName = input.firstName.trim().normalize('NFC');
  const state = input.state;
  if (!/^\p{L}[\p{L}\p{M}'’\-]{0,29}$/u.test(firstName) || !US_STATES.has(state)) return null;
  return { firstName, state };
}

export function rewardLevel(activities) {
  const points = (activities >= 3 ? 20 : 0) + (activities >= 5 ? 30 : 0) + (activities >= 10 ? 70 : 0);
  return { activities, points, level: points >= 120 ? 'In Rhythm' : points >= 50 ? 'Building Momentum' : 'Getting Started' };
}
