CREATE TABLE members (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  stripe_customer TEXT UNIQUE,
  billing_status TEXT NOT NULL DEFAULT 'none',
  tier TEXT,
  billing_checked INTEGER NOT NULL DEFAULT 0,
  reminder_time TEXT
);
CREATE INDEX members_publishing ON members(billing_status, id);

CREATE TABLE sessions (
  digest TEXT PRIMARY KEY,
  member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_expiration ON sessions(expires);

CREATE TABLE checkout_attempts (
  member TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  tier TEXT NOT NULL,
  trial INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  stripe_session TEXT
);

CREATE TABLE preferences (
  member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  effective_week TEXT NOT NULL,
  settings TEXT NOT NULL,
  PRIMARY KEY (member, effective_week)
);

CREATE TABLE plans (
  member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  week TEXT NOT NULL,
  schedule TEXT NOT NULL,
  PRIMARY KEY (member, week)
);

CREATE TABLE progress (
  member TEXT NOT NULL,
  week TEXT NOT NULL,
  activity TEXT NOT NULL,
  PRIMARY KEY (member, week, activity),
  FOREIGN KEY (member, week) REFERENCES plans(member, week) ON DELETE CASCADE
);

CREATE TABLE notices (
  member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  message TEXT NOT NULL,
  created INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member, id)
);
CREATE INDEX notices_recent ON notices(member, created DESC);
