CREATE TABLE planner_tasks (
  id TEXT PRIMARY KEY,
  member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX planner_tasks_member_day ON planner_tasks(member, day);
