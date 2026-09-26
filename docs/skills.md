# Skills

The loop abstracts an idea from work that landed and offers it back to other projects.

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
same source.

A skill is created in one of two ways. The loop abstracts one when an attempt is
kept. An admin registers one with `improve_run` action `register_skill`, naming the
finished job it was abstracted from. That job must be done, with one merged pull
request and green CI as the Worker verified them, and must not have produced a skill
before. The skill's namespace is read from the job. Drivers are refused, because a
driver registering its own skill would be judging its own run.

A status changes on VERIFIED EVIDENCE and never on a driver's report of its own run.
Verified means the Worker read it from GitHub itself: a pull request merged and CI
green, as recorded on `job_outcomes`, and a scored improve attempt when the loop runs.
Two evaluations minimum in either direction: one result is a sample. Evidence counts
per version and per probe set, so an accepted edit resets it. Edits are bounded
at 20 percent of the instruction lines, counted by distinct lines touched, and accepted
only on strict improvement. A tie is a rejection. Rejected edits are kept in
`skill_edits` and handed to the next optimizer run, so a proposal already refused is not
proposed again.

A skill is credited only when it was used and the verifier reported success.
An offered-and-ignored skill and a run that died on the environment both count as
nothing. Offered and used are both stored on `job_outcomes`. The gap between them is
its own measurement.

Failure notes are not a second score. `skill_failures` carries a note
per reverted attempt and failed job, linked to the skills in use at the time, and the
recommend step attaches the two most recent for each skill it offers. Nothing there
moves a status.

Two live skills whose triggers overlap and whose bodies differ by less than 10 percent
are proposed for merging, to a human. Only live skills. A candidate has not been
evaluated enough to merge, and a retired one is a record.

THERE IS NO SCHEDULED PROBE. Dropped 2026-09-16, ruled by Dustin as option C. The
evaluation cycle used to end by running each namespace's probe set in the scorer
sandbox twice per skill, with the skill and without it. That never happened once: the
cycle dispatched `improve-score.yml` with `mode`, `skill_id` and `skill_version`, and
that workflow declares only `branch`, `run_id` and `attempt_id`, all required, so
GitHub refused every dispatch and the cycle logged the error. It was dropped rather
than repaired because a working probe needs the loop's attempt path, model spend, and a
probe set that exists nowhere: a probe set is only the `probe_set_version` string on
`skill_evaluations`. Evidence comes from verified job outcomes instead, which is a
signal GitHub already produces.

What survives is the cycle's other half, which applies stored evidence: it reads the
evaluations, commits the transitions they decide, and audits each one. It is
fortnightly, KV-configurable under `skills:evaluate:cadence-days` and riding the
five-minute tick, which gates on the cadence before doing anything else. A cadence below
one day falls back to the default rather than being obeyed. The cadence is unchanged
from the probing design, so a status moves up to a fortnight after the evidence that
decides it lands.

THE WORKER OFFERS, AND RECORDS WHAT IT OFFERED. A job's first `claim` matches its title
and prompt against candidate and live skills (`offerSkills`, at most three) and returns them
as `offered_skills`, each with its instructions inline, since a driver scoped to its own
namespace cannot read `capsid/improve/skills/`. The offer is recorded in the same batch as
the claim, as a `job-skills-offered` audit row naming each skill and its version, and a
later claim of the same job returns that record rather than matching again. `complete` and
`fail` store the recorded offer as `skill_ids_offered`: a driver may omit `offered`, an
`offered` list that differs from the record is refused, and so is a `used` skill the job
was not offered. Offered is therefore the Worker's record and used is the driver's claim,
which is the split the observation window measures.

A FINISHED JOB IS EVIDENCE, since 2026-09-18. `jobs` action `complete` and action
`fail` take a `skills` object naming which skills the run was offered and which it
used. Those two lists are stored separately on `job_outcomes`, and the gap between them
is what judges the recommend step. NAMES ONLY: the credit direction never comes from
the driver. `signalFor` reads what this Worker verified on GitHub, and gives a win only
when every named pull request merged and CI was green, a loss when a named pull request
did not merge or CI was red, and nothing at all when the run named no pull request or
could not be verified. That last case is most jobs in this queue, which are research or
documents; counting them as losses would retire every skill on the ordinary work of the
portfolio. A skill id that does not exist is refused rather than dropped, and so is one
named as used but not as offered.

EVALUATIONS COME FROM VERIFIED JOB OUTCOMES, since 2026-09-26. The fortnightly cycle
writes one `skill_evaluations` row per candidate or live skill when enough new runs
exist. The measure (`probe_set_version` `job-outcomes-used-vs-offered-unused-v1`): among
jobs offered the skill at its current version (the Worker's `job-skills-offered`
records), the verified success rate of those whose driver reported using it, minus the
verified success rate of those that were offered it and did not. A run the Worker could
not verify counts in neither group. An evaluation needs at least 5 verified used runs and
at least one verified offered-but-unused run since the skill's last evaluation, and a
run is counted once. Each evaluation also writes a `skill-evaluated` audit row with the
four counts behind the delta.

THIS IS NOT A CONTROLLED COMPARISON, and anything reporting it must say so. A session
chooses when to use a skill, so the used and unused groups differ in more than the skill:
a driver may use it on exactly the jobs it expected to go well, or badly. The delta is an
observed association, not an effect.

STATUS CHANGES ARE HELD during the observation window (Dustin, 2026-09-26). The cycle
records evaluations and reports the transitions they decide as `held`, and applies
none, unless APP_KV `skills:transitions` reads `apply`. An unset key, any other value
and an unreadable KV all mean hold. When the window closes, the seat (admin) runs
`improve_run` action `skill_transitions` with `value: "apply"`, which is audited as
`skill-transitions-set`; the next cycle then applies what the stored evaluations
decide. `value: "hold"` sets it back. `improve_skills.wins` and `losses` are still
recorded from each verified run and still move no status.

FAILURE NOTES. A failed job, or a complete the Worker verified as a loss, writes one
`skill_failures` note per skill the run reported using, from its reason or summary.
`offerSkills` attaches the two newest to the next offer. They move no status.

The console carries a skills panel per namespace: counts by status, the last
evaluation, and the offered-to-used rate, which is the number a reader cannot compute
from the others.

Full model: `docs/schema.md`, under Skill records.
