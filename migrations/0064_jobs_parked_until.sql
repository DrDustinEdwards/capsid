-- jobs.parked_until: when a parked job comes back on its own (Dustin, 2026-11-17: "park takes a due
-- date, and the five-minute tick returns the job to the queue"). An ISO time, written by park when it
-- is given `until` and cleared when the job leaves parked; NULL for a job parked until somebody
-- unparks it, and for every older row. src/jobs-park.ts reads it on the tick.
-- Additive: one nullable column, no row touched.
ALTER TABLE jobs ADD COLUMN parked_until TEXT;
