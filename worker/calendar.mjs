const escapeText = value => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n')
  .replace(/;/g, '\\;').replace(/,/g, '\\,');

function fold(line) {
  const encoder = new TextEncoder();
  const parts = [''];
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) {
      parts.push(' ');
      bytes = 1;
    }
    parts[parts.length - 1] += character;
    bytes += size;
  }
  return parts.join('\r\n');
}

export function calendarFeed(tasks) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PlanPulse//Personal Planner//EN',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:PlanPulse Planner'];
  for (const task of tasks) {
    lines.push('BEGIN:VEVENT', 'UID:' + task.id + '@getplanpulseonline.online',
      'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + task.day.replace(/-/g, ''),
      'SUMMARY:' + escapeText(task.title));
    if (task.repeats) lines.push('RRULE:FREQ=WEEKLY');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
