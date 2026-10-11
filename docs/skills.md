# Skills

The loop abstracts an idea from work that landed and tries it on other projects' improve attempts.

A skill package is layered. The Worker reads the layers separately. The declared
fields (trigger condition, namespaces, termination test, composition interface) live on
the `improve_skills` row as well as in the repo's `SKILL.md` frontmatter, so the Worker
matches a trigger and enforces a status without cloning a repository. The instruction
body is a document, and it is what an edit is measured and bounded against. The repo
copy is the reviewable source. The stored copy is what the machine acts on, the same
split the policy documents use.

The lifecycle is three states. Every skill starts `candidate`, including one
abstracted from an attempt that was kept. Being born of a success says nothing
about whether the written form helps anybody else. A candidate goes `live` on two
positive evaluations. A live skill goes `retired` on two consecutive non-positive ones.
Retired rows stay, with their record, so the same idea is not abstracted twice from the
same source. NOTHING WRITES EVALUATIONS NOW (see "Skills no longer ride on claim" below), so
the rules for moving between states have no input and a skill stays `candidate` unless a
row is changed by hand.

A skill is created in one of two ways. The loop abstracts one when an attempt is
kept. An admin registers one with `capsid_admin_control_improve` action `register_skill`, naming the
finished job it was abstracted from. That job must be done, with one merged pull
request and green CI as the Worker verified them, and must not have produced a skill
before. The skill's namespace is read from the job. Drivers are refused, because a
driver registering its own skill would be judging its own run.

Rules that still apply to an improve attempt. A skill is credited only when it was used and
the verifier reported success: `attributionStatements` (src/skills-records.ts) writes
`improve_skills.wins` and `losses` from an attempt's scored result, and an offered-and-ignored
skill, or a run that died on the environment, counts as nothing. Edits are bounded at 20
percent of the instruction lines, counted by distinct lines touched, and accepted only on
strict improvement; a tie is a rejection. Rejected edits are kept in `skill_edits` so a
proposal already refused is not proposed again. Two live skills whose triggers overlap and
whose bodies differ by less than 10 percent are proposed for merging, to a human. These
edit and merge rules (`judgeEdit`, `mergeProposals` in src/skills-evaluate.ts) are
library code with no scheduled caller.

Skills no longer ride on claim (job_2c92174d5bff item 3). A job's first `claim` used to
match its title and prompt against candidate and live skills and return up to three as
`offered_skills`, record the offer in a `job-skills-offered` audit row, and `complete` and
`fail` took a `skills` object ({offered, used}) that was stored on `job_outcomes` and credited
against the verified outcome. All of that is removed: the claim answer carries no skills,
`complete`, `record` and `fail` take no `skills` param, and `job_outcomes` no longer writes
`skill_ids_offered` or `skill_ids_used` (the columns stay, unused; rows written before keep
their values). The fortnightly evaluation cycle read exactly those two sources, so with no
offers it had no evidence to gather and is removed with them: the `skill-cycle` tick task,
the cadence and last-run KV keys, `capsid_admin_control_improve` action `skill_transitions`
and its hold/apply switch (`skills:transitions`), `commitTransition` and `dueTransitions`.
The tables (`improve_skills`, `skill_evaluations`, `skill_failures`, `skill_edits`) and
their history stay. Failure notes (`skill_failures`) have no writer now either; they were
written for the skills a failed job reported using.

A skill a project wants every session to follow is committed to that project instead, as a
Claude Code skill under `.claude/skills/<name>/SKILL.md` (or a plugin), so the session loads
it by its own description and no claim has to carry it. This repo carries
`.claude/skills/reproduce-before-fixing/SKILL.md`, the body of the stored skill
`capsid/improve/skills/reproduce-before-fixing.md`. Model routing did not move:
`src/model-routing.ts` still sets `model_recommended` on a job at claim and the fire text
sends it.

WHAT STILL USES STORED SKILLS. The improve loop. `candidateSkills` (src/improve-skills.ts)
hands an attempt candidate and live skills from other namespaces that claim this one (or
none), best Laplace-smoothed win rate first, in the no-transfer condition, and wins and
losses are credited from the attempt's scored result. An admin registers a skill with
`register_skill` (above), so a registered skill is tried on other projects' attempts.

THERE IS NO SCHEDULED PROBE. Dropped 2026-09-16, ruled by Dustin as option C: the probe
dispatched `improve-score.yml` with inputs that workflow does not declare, so GitHub refused
every dispatch. Verified job outcomes replaced it as the evidence source on 2026-09-26, and
those depended on the claim-time offer, which is the part removed above. Reviving
evaluation means choosing a new evidence source; it needs a ruling in `capsid/decisions.md`.

Capsid Portal's skills line per namespace shows counts by status and the last stored
evaluation. The offered-to-used rate is gone with the data behind it.

Full model: `docs/schema.md`, under Skill records.
