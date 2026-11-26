ALTER TABLE planner_tasks ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE planner_tasks ADD COLUMN repeats INTEGER NOT NULL DEFAULT 0;

CREATE TABLE planner_completions (
  task TEXT NOT NULL REFERENCES planner_tasks(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  PRIMARY KEY (task, day)
);

CREATE TABLE planner_shares (
  owner TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  PRIMARY KEY (owner, email)
);

CREATE INDEX planner_shares_email ON planner_shares(email);
