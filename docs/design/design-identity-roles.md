# Lab login and lab people: one identity and roles model

Job `job_4acb6ae89b9f` (capsid, kind design), posted by Dustin on 2026-10-09 while answering the Knowledge Base
design (dustinedwards-info `docs/KNOWLEDGE-BASE.md`, DECIDE 3). The job named `capsid/research/design-identity-roles.md`
as its home; this session may not write to Capsid, so the design sits here and the seat can move it.

**Scope (Dustin's narrowing):** how lab people log in, and how lab managers manage members and levels. Names and
URLs for later functions are reserved, not designed. Design only: nothing built, no account setting changed.

## In brief

1. **Login stays Cloudflare Access**, verified in the Worker with jose. The lab gets **its own Access application** on
   `/lab`, never a policy on `dustinedwards-login`, where every admitted person is the site admin.
2. **Email code first.** Microsoft sign-in for Tarleton needs Tarleton IT; Google is optional.
3. **Owner, Lab manager, Lab worker.** Access decides who reaches the sign-in; a `lab_members` table decides what each
   may do. No row, no access. Managers manage workers; the Owner manages managers. `/admin` stays the Owner's.
4. **Small shared code.** The Access check moves to site-runtime; roles stay a per-app table; Capsomer gains
   `people-roles`.
5. **Seats bind on people.** Any Access sign-in holds a seat until removed or expired, even when the app refuses.

## What exists (read for this design)

Commits read: capsid `e2762d8`, carrel `2295d38`, dustinedwards-info `d3aefbe`, site-runtime `d5a7676`, capsomer
`7612bd5`. germomics is private and this session could not attach it; its Access facts come from the germomics job
mirror in Capsid (`germomics/jobs/job_bc516ba762a7.md`: "Cloudflare Access (application germomics-login) in front of
/admin, verified with jose", after PR #41).

| Where | What it does today |
| --- | --- |
| carrel `app/lib/access.server.ts` | jose against the team's certs, issuer and AUD, RS256. Its `catch` returns `invalid-token` for every error, so a certs outage reads as a bad token. |
| carrel `workers/gate.ts`, `app/lib/people.server.ts` | Access token, then the active `people` row by email; anyone else gets a bare 403. |
| carrel `app/lib/roles.ts` | `reader` (read, comment), `editor` (+ edit), `owner` (+ publish, manage, deletes). `can(role, action)`; no role can do nothing. |
| carrel README, "People and flags" | `/people` is the Owner's alone (404 otherwise). It refuses a second Owner, as does the database. Adding a person does not get them past Access; the page says where to allow the email. |
| dustinedwards-info `app/lib/access-verify.mjs` | jose, RS256, 60 s clock tolerance, named refusal reasons; a key-set fault is thrown, not read as a refusal. |
| dustinedwards-info `app/routes/admin.tsx`, `app/lib/access.server.ts` | Any `human` identity under `ACCESS_AUD` is the admin. No role table. The `CF_Authorization` cookie shows drafts to that person on public pages. |
| dustinedwards-info `docs/RUNBOOK.md` 5b | Application `dustinedwards-login` on `/admin`, policy `dustinedwards-admin` (Include: Emails), team domain `dustinedwards.cloudflareaccess.com`. Machines use a service token. |
| dustinedwards-info `app/routes.ts` | The public registry is at `/research/lab`; top-level `/lab` is unused and held free by the KB design. |
| dustinedwards-info `docs/KNOWLEDGE-BASE.md` | Lots, locations, runs, members in D1 with `kb_audit`; lot and run pages planned under `/admin/kb`; Carrel's procedure and registry handlers removed once the admin editor is live. |
| site-runtime `README.md` | Security headers today, no dependencies; "the Access check ... to move in later, each as its own subpath." |
| capsomer `components/` | Has `permission-matrix`, `confirm-dialog`, `switch-reason`, `table`, `approval-sheet`. No people-management component. |
| capsid `docs/auth.md` | Every caller is an agent with scopes; audit rows as `agent:<name>`, the form Carrel also uses. |
| Capsid search | The co-owner appears only as a planning note ("Dustin's wife becomes co-owner later", `capsid/jobs/job_1b187d1b44e5.md`); no design for it exists. |

## The starting proposal, tested

**1. Login through Access, Microsoft and Google plus email code, one shared check.** Access holds. Three corrections:

- *A separate application, or every lab person is the site admin.* A lab person admitted by a second policy on
  `dustinedwards-login` would hold a token for `ACCESS_AUD`, so `admin.tsx` would make them the admin and public
  pages would show them drafts. The lab gets its own application, `dustinedwards-lab-login`, with its AUD in a new
  var `LAB_ACCESS_AUD`. Each gate refuses the other's token, with a plant test for each.
- *Microsoft needs Tarleton IT.* Cloudflare's Entra ID setup takes one Directory (tenant) ID and an app registered in
  that directory, and its tested permissions end with "Grant admin consent" (Cloudflare docs, Entra ID). Tarleton
  accounts live in Tarleton's tenant, so that is Tarleton IT's to give. Researcher's own knowledge, unchecked against
  Tarleton: university tenants commonly block users from consenting to outside apps. Until then email code serves
  Tarleton people at the same address, so adding Microsoft later changes nothing in the app.
- *Google is optional.* Email code serves outside collaborators too; Google needs its own OAuth client. Add it when
  someone asks.

New Zero Trust organizations now start with the Cloudflare identity provider; existing ones keep their methods
(Cloudflare changelog, 2026-06-18). This team's methods were not read (an account setting); the lab application
should allow only email code until Microsoft is added.

**2. Owner, Lab manager, Lab worker; Carrel's roles extracted to a shared package; a Capsomer component; each app
keeps its own memberships.** The levels and per-app memberships hold. The shared package does not:

- Carrel's roles are per-project content rights; lab levels are workspace rights over inventory, runs and members.
  The tables share a shape and no rows. The shape (`ALLOWED` plus `can()`) is ten lines each app holds itself.
- What is truly shared is verifying the Access token, which goes to site-runtime as planned, and the UI, one
  Capsomer component for Carrel's `/people` and the lab's members page.

**3. A separate `/lab` workspace; `/admin` owner-only; lab writing in Carrel.** The workspace and `/admin` hold. Lab
writing in Carrel conflicts with what is decided: Dustin ruled on 2026-10-07 that "procedures are structured, not
writing" (recorded when dustinedwards job_2cbe6e8e6c60 was superseded), and the KB plan removes Carrel's procedure
handler. The recommendation is the KB editor mounted in `/lab` for Lab managers with a draft-only save through the
same save path, publishing left in `/admin/kb` for the Owner: one editor, one validator, and Carrel's rule that only
the Owner publishes (decision 2a) kept. The seat's version is the alternative in DECIDE 6. The KB plan's lot and run
pages move from `/admin/kb` to `/lab`, since workers record runs.

**4. Zero Trust free plan seat limit.** See "Seats" below.

## The login flow

1. A person opens `https://dustinedwards.info/lab`. Access intercepts (application `dustinedwards-lab-login`,
   destinations `/lab` and `/lab/*`).
2. Policy `dustinedwards-lab-members` (Allow) includes the Access group `lab-people`: emails ending in `@tarleton.edu`
   plus named outside emails (DECIDE 2). Anyone else never receives a code ("By design, blocked users will not
   receive an email", Cloudflare docs, One-time PIN).
3. The person enters their email, receives a code that expires in 10 minutes, and signs in. This is the moment a seat
   is taken.
4. The Worker's `/lab` layout middleware verifies the token with site-runtime's check against `LAB_ACCESS_AUD`
   (signature, RS256, issuer, audience, expiry). A failed token is a 401 with its reason, as the admin does. A
   certs-endpoint outage is thrown and shows as an outage.
5. It lowercases the email and looks up `lab_members` where `removed_at IS NULL`, on every request, uncached, so a
   removal takes effect on the next click.
   - Owner: the email is in `LAB_OWNERS` (DECIDE 5). Owners need no row.
   - A row: its level.
   - Neither: a 403 page, private and `noindex`: "No access yet. Ask your lab manager to add you as
     `<the email you signed in with>`." It names no managers, since anyone at Tarleton can reach it.
6. Every handler asks `can(level, action)`. A page a level cannot use is a 404 (Carrel's pattern), so a worker
   cannot learn the members page exists.

workers.dev and preview hosts have no Access application, so the lab refuses everyone there, as the admin does.
Local development admits `dev@localhost` as Owner under `access.server.ts`'s existing conditions.

**To verify while building (not settled by docs this session):** whether two path-scoped Access applications on one
host keep separate sessions in one browser. The lab gate PR checks that signing in to `/lab` does not sign Dustin out
of `/admin` or hide drafts from him. If it does, the workspace moves to the reserved `lab.dustinedwards.info`.

## Levels and what each may do

Stored values `owner`, `manager`, `worker`; shown as Owner, Lab manager, Lab worker.

| Action | Worker | Manager | Owner |
| --- | --- | --- | --- |
| See inventory, lots and locations, including private fields | yes | yes | yes |
| Mark a lot opened, used or empty | yes | yes | yes |
| Record a run and see their own runs | yes | yes | yes |
| See every member's runs | | yes | yes |
| Add or edit lots, locations and items | | yes | yes |
| Draft a procedure change (draft-only save) | | yes | yes |
| Publish a procedure or item | | | yes, in `/admin/kb` |
| Add, re-level or remove a Lab worker | | yes | yes |
| Add or remove a Lab manager; promote a worker to manager | | | yes |
| Anything in `/admin` | | | yes |

The action names in code: `read`, `use_lot`, `record_run`, `read_all_runs`, `edit_inventory`, `draft_procedure`,
`manage_workers`, `manage_managers`. Publishing is not a lab action: it stays in `/admin`.

## The manager workflow

**Add.** Managers and the Owner see **Members** in the `/lab` rail: active members (name, email, level, added by,
added on, last seen) and a form (email, name, level). A manager's form offers only Lab worker. Saving writes a
`lab_members` row and a `kb_audit` row (who, when, before, after) and says "Added. They sign in at
dustinedwards.info/lab with this email." For an address outside `@tarleton.edu` it adds "ask Dustin to add this
email to the lab sign-in list", an Access group edit, as Carrel's People page does.

**Change level.** A level select with a required reason (`switch-reason`). Anything touching Lab manager is the
Owner's. Audited.

**Remove.** Behind `confirm-dialog`, sets `removed_at`; the row is never deleted, so runs keep their author. The next
request gets "No access yet"; the Access session and the seat outlive it. Re-adding clears `removed_at`.

**What a worker sees.** Inventory, their own Runs, Protocols (read, private fields included). No Members entry;
`/lab/members` is a 404. The Owner sees what a manager sees, the Owner-only choices, and `/admin`.

## Seats

What Cloudflare's seat documentation says (read from the docs source on 2026-10-09):

- A seat is taken by "any Cloudflare Access authentication event", once per person across all applications.
- When seats run out, "additional users who attempt to log in are blocked."
- Removing a user in Zero Trust frees the seat; revoking only ends sessions.
- Seat expiration removes inactive users after a set period ("between one month and one year" in the source; a
  summary of the published page said two months, so use the shortest the dashboard offers).
- Service tokens reach applications "without consuming seats".

**The free plan's number.** Third-party pages in 2026 give 50 users free and about $7 per user per month beyond.
Cloudflare's plans page was unreachable from this session and the docs read do not state it, so it is unconfirmed;
the Cloudflare One overview shows seats used and left.

**When it binds.** Seats are shared by every Access application on the account (the site admin, Carrel's two doors,
germomics, the Portal, the lab). It binds when distinct people signed in within the expiration window pass the limit.
A research lab of 5 to 15 plus a few Carrel collaborators stays well under 50. A teaching cohort is what binds: if
Phage Discovery Program students get `/lab` accounts each year, seats pile up unless they expire. With the
`@tarleton.edu` rule, any Tarleton person who finds `/lab` and signs in takes a seat although the app refuses them;
`/lab` is not linked publicly, which makes that unlikely, not impossible. So turn on seat expiration at the shortest
setting (an expired person who returns just takes a seat again), and past about 40 seats switch `lab-people` to
named emails (DECIDE 2).

## What moves where

| Home | Change |
| --- | --- |
| site-runtime | Subpath `./access`: the site's `verifyAccessToken` plus the identity read (email, or a service token's `common_name`). jose as a peer dependency (the package has none; both apps ship jose). |
| dustinedwards-info | Admin adopts `./access`. New `/lab` gate, `lab_members`, `LAB_ACCESS_AUD`, `LAB_OWNERS`, refusal page, `/lab/members`; KB lot and run screens in `/lab`; KB DECIDE 3 recorded. |
| Carrel | Adopts `./access` (a certs outage then reads as an outage). Later, `people-roles` for `/people`. The single-Owner rule changes with the co-owner, not here. |
| Capsomer | `people-roles`: member table, add form, level select with reason, remove confirmation, `permission-matrix` as the read view. |
| Cloudflare account (Dustin) | Group `lab-people`, application `dustinedwards-lab-login`, policy `dustinedwards-lab-members`, email code, seat expiration. |
| Capsid, Portal | Nothing now. |

## Pull request order

Each repo runs one after another. Visual PRs carry the label and wait for Dustin.

1. **site-runtime:** `./access` with tests (a planted wrong-audience token goes red), tagged.
2. **dustinedwards-info:** admin adopts `./access`, no behaviour change.
3. **Carrel:** adopts `./access`. Independent of 2.
4. **Dustin, account step:** the group, application and policy, email code, seat expiration; AUD into
   `LAB_ACCESS_AUD`.
5. **dustinedwards-info:** `lab_members` migration (with `kb_audit` if KB step 4 has not landed), the `/lab` gate,
   refusal page, role table, empty home. Plants: admin token refused at `/lab`; lab token refused at `/admin` and no
   admin on public pages; removed member refused; worker 404 at `/lab/members`; manager cannot make a manager. Plus
   the two-session check.
6. **Capsomer:** `people-roles`, visual.
7. **dustinedwards-info:** `/lab/members` on it, visual.
8. **dustinedwards-info:** KB steps 4 and 7 build lots and runs under `/lab`; managers' draft view follows KB step 3.
9. **Carrel:** `/people` on `people-roles`, visual, optional.

## Reserved names

Kept free now so later work slots in without renames. Designed: none of the later functions.

| Name | Reserved for | Why this name |
| --- | --- | --- |
| `/lab` | The workspace (built here) | Held free by the KB design. |
| `/lab/members` | Members page (built here) | Says what it holds. |
| `/lab/inventory`, `/lab/runs` | KB lot, location and run screens | The KB plan's nouns. |
| `/lab/studies` | The research lab function | Carrel already uses "projects". |
| `/lab/ai` | The virtual or AI lab | Same gate, short. |
| `/lab/instruments` | Instruments and robots | Covers both. |
| `/lab/stop` | Stop control for physical actions | Fixed address for an emergency. |
| `lab.dustinedwards.info` | Fallback host for the workspace | Same word as the path. |
| `lab-mcp.dustinedwards.info` | AI door for lab agents | Follows `carrel-mcp`. |
| Access group `lab-people` | Who may reach any lab sign-in | One list for every lab app. |
| Access app `dustinedwards-lab-login` | `/lab` sign-in (built here) | Follows `germomics-login`. |
| Access policy `dustinedwards-lab-members` | Allow `lab-people` (built here) | Follows `dustinedwards-admin`. |
| Access policy `dustinedwards-lab-service` | Service Auth for instruments, robots, CI | Service tokens take no seat. |
| Access app `dustinedwards-lab-ai` | The AI door's application | Pairs with `/lab/ai`. |
| Vars `LAB_ACCESS_AUD`, `LAB_OWNERS` | Lab audience; the Owners | Beside `ACCESS_AUD`. |
| Table `lab_members` | People and levels (built here) | `lab_` for people and actors. |
| Table `kb_audit` | One audit for lab and KB writes | KB plan's name; one history. |
| Tables `kb_lots`, `kb_locations`, `kb_runs` | Inventory and runs | `kb_` for KB data. |
| Tables `lab_actors`, `lab_instruments`, `lab_approvals`, `lab_studies` | Non-human actors, instruments, approvals for physical runs (biosafety sign-off attaches here), studies | One noun each. |
| Levels `owner`, `manager`, `worker` | Stored values (built here) | Distinct from Carrel's. |
| Level `observer` | Read-only people (collaborator, safety officer) | A fourth level, no renames. |
| Actor ids `agent:<name>`, `instrument:<name>`, `robot:<name>` | Non-human actors in audit rows | Capsid's and Carrel's form. |
| Capsomer `people-roles` | Member management (built here) | The seat's "People and roles". |
| Capsomer `run-record`, `stop-control`, `actor-badge` | Run provenance, stop control, actor mark | Approvals reuse `approval-sheet`. |
| Capsid namespace `lab` | Lab automation agents and jobs | Per-area namespaces. |

## Not designed here

Physical-action gating, instrument provenance, the AI lab's actor model, the biosafety (IBC) approval flow, linking
one person's two emails, and a Portal who-can-do-what view (dropped when Dustin narrowed the job on 2026-10-09).

## Sources

Read on 2026-10-09, under https://developers.cloudflare.com: `/cloudflare-one/integrations/identity-providers/entra-id/`,
`/cloudflare-one/integrations/identity-providers/one-time-pin/`, `/changelog/post/2026-06-18-cloudflare-idp-default/`,
and `/cloudflare-one/team-and-resources/users/seat-management/` (read from its source in the `cloudflare-docs`
repository). Free plan size and price, third-party and unconfirmed:
https://costbench.com/software/business-vpn/cloudflare-zero-trust/

## DECIDE

1. Lab sign-in is its own Access application, `dustinedwards-lab-login` on `/lab`, never a policy on
   `dustinedwards-login`. **Recommend yes:** otherwise every lab person is the site admin.
2. Who Access lets reach the lab: every `@tarleton.edu` address plus named outside emails, or named emails only.
   **Recommend the domain plus named emails:** managers add Tarleton people with no step for Dustin; switch to named
   emails if seats pass about 40.
3. Login methods: email code at launch; Microsoft when Tarleton IT registers or approves the app; Google only if an
   outside collaborator asks. **Recommend this order.**
4. Lab managers add, re-level and remove Lab workers; only the Owner adds, promotes or removes Lab managers.
   **Recommend yes.**
5. Owners are the people in `dustinedwards-admin`, mirrored in the `LAB_OWNERS` var (Dustin now, the co-owner later),
   and the app can never grant Owner. **Recommend yes.**
6. Where managers edit protocols: the KB editor in `/lab` with a draft-only save, publishing in `/admin/kb`; or the
   seat's version, Carrel with its procedure handler kept. **Recommend the KB editor in `/lab`:** it follows your
   2026-10-07 ruling that procedures are structured, and the KB plan already removes Carrel's handler.
7. The KB plan's lot, location and run screens move from `/admin/kb` to `/lab`. **Recommend yes.**
8. Shared code: the Access check moves to site-runtime `./access` with jose as a peer dependency; no shared roles
   package; one new Capsomer component, `people-roles`. **Recommend yes.**
9. Turn on seat expiration at the shortest setting, and confirm the free seat count on the Cloudflare One overview.
   **Recommend yes** (an account setting, so yours).
10. Keep the reserved names above free. **Recommend yes.**
