-- SQLite schema for Knowledge Base Workbench
-- Strict isolation, WAL mode enabled at connection time

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'staff')),
  name TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL DEFAULT '',
  overview TEXT NOT NULL DEFAULT '',
  inputs TEXT NOT NULL DEFAULT '',
  outputs TEXT NOT NULL DEFAULT '',
  integrations TEXT NOT NULL DEFAULT '',
  deployment TEXT NOT NULL DEFAULT '',
  deliverables TEXT NOT NULL DEFAULT '',
  exclusions TEXT NOT NULL DEFAULT '',
  creator_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'pending_review', 'approved', 'returned', 'revoked')) DEFAULT 'draft',
  draft_version INTEGER NOT NULL DEFAULT 1,
  public_title TEXT NOT NULL DEFAULT '',
  public_summary TEXT NOT NULL DEFAULT '',
  approved_by TEXT,
  approved_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_projects_category ON projects(category);

CREATE TABLE IF NOT EXISTS project_features (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  feature_text TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_features_project ON project_features(project_id);

CREATE TABLE IF NOT EXISTS project_phases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  phase_name TEXT NOT NULL,
  scope_description TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL CHECK(relation IN ('standalone', 'cumulative', 'alternative', 'unknown')) DEFAULT 'unknown',
  amount_min REAL,
  amount_max REAL,
  currency TEXT NOT NULL DEFAULT '',
  raw_amount_text TEXT NOT NULL DEFAULT '',
  cost_scope TEXT NOT NULL DEFAULT '',
  source_file_id TEXT,
  source_location TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'file' CHECK(source_type IN ('file', 'staff_supplement')),
  allow_cs_quote INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_phases_project ON project_phases(project_id);

CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  parse_status TEXT NOT NULL CHECK(parse_status IN ('pending', 'parsed', 'partial', 'unsupported', 'failed', 'image_stored_no_vision')) DEFAULT 'pending',
  extracted_text TEXT NOT NULL DEFAULT '',
  parse_error_reason TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_project ON project_files(project_id);

CREATE TABLE IF NOT EXISTS project_chat (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  structured_patch_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_project ON project_chat(project_id);

CREATE TABLE IF NOT EXISTS project_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('approved', 'returned', 'revoked')),
  reason TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reviews_project ON project_reviews(project_id);

CREATE TABLE IF NOT EXISTS style_references (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  desensitized_example TEXT NOT NULL,
  source_file_id TEXT,
  source_location TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_styles_project ON style_references(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('file_parse', 'ai_organize')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'failed', 'success', 'interrupted')) DEFAULT 'pending',
  progress REAL NOT NULL DEFAULT 0.0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);

-- Full-Text Search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  project_id UNINDEXED,
  title,
  category,
  scenario,
  overview,
  features,
  deliverables
);
