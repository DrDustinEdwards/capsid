-- AUTOMATIC MODEL ROUTING (capsid/research/design-model-routing.md; src/model-routing.ts).
--
-- WHAT WAS MISSING. Capsid recorded the model a session reported (job_claims.model_id) but
-- never chose one, so the model for a job was whatever tab it happened to run in, and no
-- outcome could be read against the model Capsid would have picked.
--
-- A job now carries its kind and the model and effort Capsid recommends for it, with the
-- one-line reason; an outcome carries the kind, the model chosen and the model the session
-- reported it actually ran. NULL on every column means "not routed": a job posted before
-- this migration is routed at its next claim, and an outcome written before it stays NULL,
-- never a guessed model.
--
-- Additive: seven nullable columns, no default, no index, no backfill. ALTER TABLE ADD
-- COLUMN is not idempotent; wrangler runs each file once.

ALTER TABLE jobs ADD COLUMN kind TEXT;
ALTER TABLE jobs ADD COLUMN model_recommended TEXT;
ALTER TABLE jobs ADD COLUMN effort_recommended TEXT;
ALTER TABLE jobs ADD COLUMN routing_reason TEXT;

ALTER TABLE job_outcomes ADD COLUMN job_kind TEXT;
ALTER TABLE job_outcomes ADD COLUMN model_chosen TEXT;
ALTER TABLE job_outcomes ADD COLUMN model_actual TEXT;
