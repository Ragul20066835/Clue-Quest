-- =========================================================================
-- CLUE QUEST: Migration 001 - Performance & Concurrency Indexes
-- Department of Electronics & Communication Engineering, VSB Engineering College
--
-- Safe, non-destructive, idempotent index creation for 40-user concurrency.
-- Supports hot path queries for /api/game/state, /api/auth/team, and /api/admin/overview.
-- =========================================================================

-- 1. Accelerates active event resolution (SELECT * FROM events ORDER BY created_at DESC LIMIT 1)
CREATE INDEX IF NOT EXISTS idx_events_created_at_desc
ON events(created_at DESC);

-- 2. Accelerates case-insensitive team lookups during registration & session checks (WHERE LOWER(team_name) = $1)
CREATE INDEX IF NOT EXISTS idx_users_lower_team_name
ON users(LOWER(team_name));

-- 3. Accelerates admin dashboard participant integrity audit aggregation (WHERE event_id = $1 AND action = 'INTEGRITY_EVENT' GROUP BY user_id)
CREATE INDEX IF NOT EXISTS idx_logs_event_action_user
ON event_logs(event_id, action, user_id);
