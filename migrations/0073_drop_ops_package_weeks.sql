-- contract: the package watch (capsid #1118) retired on 2026-11-28, and nothing reads or writes this table any more.
-- Dustin approved dropping it in the thread (2026-11-28 17:45 UTC): 15 rows, no backup wanted.
--
-- Hand run (a drop): applied 2026-11-28 with its d1_migrations row.
DROP TABLE IF EXISTS ops_package_weeks;
