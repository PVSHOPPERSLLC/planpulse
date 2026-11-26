CREATE TABLE planner_calendar_feeds (
  member TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  digest TEXT NOT NULL UNIQUE
);
