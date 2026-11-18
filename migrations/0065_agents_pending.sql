-- agents.pending: a minted key waits for a click in the Portal before it resolves (security review
-- round 4, finding 1; Dustin, 2026-11-18: "a Portal click is required for creating keys"). Every
-- project thread is the admin and can mint, so a mint a thread was talked into reaches nothing until
-- a person activates it on the agent's drawer (the activate_agent control, Portal only). 1 for a new
-- mint, set to 0 by activation; src/agents.ts resolves only rows with 0.
-- Additive: one column whose default keeps every existing key working, no row touched.
ALTER TABLE agents ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
