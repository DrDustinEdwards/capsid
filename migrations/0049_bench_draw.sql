-- THE PAIRED COMPARISON'S REGISTRATION AND DRAW (the methods paper's protocol, section 4,
-- "Draw"). Before the first confirmatory model run, the registration's hash, the frame
-- file's hash, the sampling seed and the drawn task order are recorded here, and
-- /bench/start (src/bench.ts) refuses a model arm on a full-split task until they are,
-- and refuses a full-split task that is not on the draw.
--
--   bench_registration  one row. Insert-only: no UPDATE, and a DELETE only while no
--                       model run names a drawn task (a re-plan is a new registration
--                       before any confirmatory run).
--   bench_draw          the drawn tasks in draw order. Insert-only, appended at the end;
--                       no UPDATE, and no DELETE once a model run names a drawn task, so
--                       the draw cannot shrink after model runs have started.
--
-- Additive: two new tables and their triggers. Nothing existing changes.

CREATE TABLE IF NOT EXISTS bench_registration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- sha256 of the registration as filed, lowercase hex.
  registration_sha256 TEXT NOT NULL CHECK (length(registration_sha256) = 64),
  -- sha256 of the frame file the draw is taken from, lowercase hex.
  frame_sha256 TEXT NOT NULL CHECK (length(frame_sha256) = 64),
  -- The sampling seed written in the registration, as written.
  seed TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bench_draw (
  -- 1-based place in the draw order.
  position INTEGER PRIMARY KEY CHECK (position >= 1),
  task_id TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS bench_registration_insert_only BEFORE UPDATE ON bench_registration
BEGIN SELECT RAISE(ABORT, 'bench_registration is insert-only'); END;
CREATE TRIGGER IF NOT EXISTS bench_registration_frozen_delete BEFORE DELETE ON bench_registration
WHEN EXISTS (SELECT 1 FROM bench_runs r JOIN bench_draw d ON d.task_id = r.task_id WHERE r.arm IN ('baseline', 'treatment'))
BEGIN SELECT RAISE(ABORT, 'bench_registration: frozen once a drawn task has a model run'); END;
CREATE TRIGGER IF NOT EXISTS bench_draw_insert_only BEFORE UPDATE ON bench_draw
BEGIN SELECT RAISE(ABORT, 'bench_draw is insert-only'); END;
CREATE TRIGGER IF NOT EXISTS bench_draw_frozen_delete BEFORE DELETE ON bench_draw
WHEN EXISTS (SELECT 1 FROM bench_runs r JOIN bench_draw d ON d.task_id = r.task_id WHERE r.arm IN ('baseline', 'treatment'))
BEGIN SELECT RAISE(ABORT, 'bench_draw: the draw cannot shrink once a drawn task has a model run'); END;
