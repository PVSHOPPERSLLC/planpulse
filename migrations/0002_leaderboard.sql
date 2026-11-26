CREATE TABLE IF NOT EXISTS leaderboard_profiles (
  member TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  state TEXT NOT NULL
);
