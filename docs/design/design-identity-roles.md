# People and roles across the family

Job `job_c9f130f528bb`, revising the lab-only design from job_4acb6ae89b9f (capsid PR #304). The ruling this follows
is `capsid/decisions.md`, "2026-10-09: people and roles across the family"; where this document and the ruling
differ, the ruling wins. Design only: nothing built, no account setting changed.

## In brief

- One shared way of managing people, used by every app that has staff. Each app names its own titles: the lab (Lab
  manager, Lab worker), txasm (President, Treasurer, Program chair and so on), Foxing and Foxing Edu (their staff
  roles). Each app keeps its own member list, and being in one grants nothing in another.
- Each app's **members page is the only list**. Adding a person there puts their email on that app's Cloudflare
  Access allow list; removing them takes it off and frees their seat. Nobody edits Cloudflare by hand after setup.
- Sign-in is Cloudflare's **emailed one-time code**, typed in, with a one-month session. No Microsoft or Google.
- **Layers decide who manages whom; permissions decide what a person can do.** Code checks permissions, never titles.
- **Dustin is the Primary Owner**, set in deployment configuration. His wife is an Owner who can do everything but
  remove or demote him.
- **Access expires by default** (end of semester, end of term), leads renew with one click, every lead gets a
  "still on your team?" review each semester, and every change is audited.
- App users (Foxing readers and teachers, Foxhound merchants, txasm authors) are not part of this. They sign in
  through each app's own login and take no Cloudflare seat.

## What already exists

Read for PR #304 (carrel `2295d38`, dustinedwards-info `d3aefbe`, site-runtime `d5a7676`, capsomer `7612bd5`):

- **Access checks.** Carrel (`app/lib/access.server.ts`) and dustinedwards.info (`app/lib/access-verify.mjs`) each
  verify the Access token with jose, RS256. The site's version names each refusal and treats a certs outage as an
  outage; Carrel's reads every error as a bad token. site-runtime's README already plans "the Access check" as a
  subpath.
- **The site admin.** dustinedwards.info's `app/routes/admin.tsx` makes every person the `dustinedwards-login`
  application admits the admin. So a members-managed app must never share an Access application with an admin
  surface: each gets its own application and audience tag.
- **Carrel's people.** `app/lib/roles.ts` maps roles to actions with `can(role, action)`; `/people` is the Owner's
  alone and refuses a second Owner. Today adding a person there does not reach Access; the page tells the Owner
  where to add the email by hand. This design removes that hand step.
- **Capsomer** has `permission-matrix`, `table`, `switch-reason`, `confirm-dialog` and `approval-sheet`, and no
  people-management component.
- **Access names** follow `<site>-login` for the application and `<site>-admin` for its policy
  (`dustinedwards-login`, `germomics-login`).

## How a person signs in

1. They open the app's staff area (for the lab, `https://dustinedwards.info/lab`). Cloudflare Access stops them.
2. The app's Access policy allows one Access group, that app's allow list (for the lab, `lab-people`). Only emails
   on it get a code: "By design, blocked users will not receive an email" (Cloudflare, One-time PIN).
3. They type their email, then type the code from the email (valid 10 minutes). The email also carries a link,
   but people type the code: email scanners sometimes open the link first and use the code up (Cloudflare,
   One-time PIN, "This One-Time PIN has already been used").
4. Signing in takes a seat. The session lasts one month (below).
5. The app's server checks the token with the shared site-runtime check against that app's own audience tag. A bad
   token gets a 401 with its reason; a certs outage shows as an outage.
6. It reads the person's row in `members` on every request, uncached, so a removal or an expiry takes effect on the
   next click. No row, or an expired one, gets a private page: "You don't have access. Ask the person who manages
   your team to add `<the email you used>`." It names nobody.
7. Each handler asks whether the person holds the permission it needs. A page they cannot use is a 404.

**One-month sessions.** An application's session can be set from immediate to one month, and so can each policy's.
Separately, the account-wide global session (15 minutes to one month, default 24 hours) decides how often anyone
must sign in again across all applications (Cloudflare, Session management). For people to sign in once a month,
the global session must be one month too, which also lengthens it for Dustin's admin applications. Those keep
shorter policy sessions and a second factor (DECIDE 3, 4).

**Dustin's own sign-in** does not rest on emailed codes alone. Access can require a second factor (an authenticator
app or a security key) per application or per policy (Cloudflare, MFA requirements). The admin applications
require one; the members-managed ones do not.

## Layers and permissions

Every member holds one title. A title is a named bundle of permissions, defined once per app in code, and sits on a
layer. Code asks "does this person hold `edit_inventory`?", never "is this a Lab manager?", so a title can be renamed
or split without touching a check.

| Layer | Who | How they are set |
| --- | --- | --- |
| 0 | Primary Owner: Dustin, and only Dustin | Deployment configuration, never a members page |
| 1 | Owner: Dustin's wife, for continuity | Members page, by the Primary Owner only |
| 2 | Leads: Lab manager; txasm President; Foxing staff leads | Members page, by layer 0 or 1 |
| 3 | Members: Lab worker; other txasm officers; Foxing staff | Members page, by layers 0 to 2 |

Two rules, enforced in one shared function:

1. **You manage only people below your own layer.** A Lab manager adds, renews and removes Lab workers, not another
   Lab manager. The Owner manages leads and members but cannot remove or demote the Primary Owner (who has no row to
   remove). Only the Primary Owner adds or removes an Owner.
2. **You grant nothing you do not hold.** The bundle you give must be a subset of your own permissions.

Each app chooses how many of layers 2 and 3 it uses. The lab's bundles, as an example:

| Permission | Lab worker | Lab manager |
| --- | --- | --- |
| `read` inventory, lots, protocols (private fields included) | yes | yes |
| `use_lot` (mark opened, used, empty) | yes | yes |
| `record_run`, see own runs | yes | yes |
| `read_all_runs` | | yes |
| `edit_inventory` (items, lots, locations) | | yes |
| `draft_procedure` (draft only) | | yes |
| `manage_members` (layer 3 only, by rule 1) | | yes |

Publishing stays with the Owners in `/admin`. txasm and Foxing define their bundles when they adopt.

## The members page

One Capsomer component, `people-roles`, used by every app. A lead sees only the people they may manage, plus
themselves.

- **Add.** Email, name, title (only titles below the lead's layer, within their permissions). The end date fills
  in from the title's default and can be shortened. Saving writes the row and an audit row, then updates the
  allow list. The page shows "Ready: they can sign in" once Cloudflare confirms, or "Waiting for Cloudflare" with
  a retry while it has not.
- **Change title.** A select with a required one-line reason, under both rules above.
- **Renew.** One click sets the end date to the end of the next semester or term.
- **Remove.** Behind a confirmation. The person is refused on their next request, taken off the allow list and
  removed from Zero Trust so the seat frees. The row stays, marked removed, so their runs and edits keep their name.
- **History.** Every change for a person: who, when, what, the before and after, and whether Cloudflare accepted it.
- **Review.** Each semester or term, a lead's page opens as a checklist: keep or remove, per person. What is not
  answered by the end date lapses.

What a Lab worker sees in the lab: inventory, their own runs and the protocols. No Members entry.

## Expiry and review

- Every row has an end date. The title sets the default: Lab worker, the end of the semester; txasm officer, the
  end of their term. Owners and the Primary Owner do not expire.
- The Owner enters each app's semester or term end dates once a year on a settings line.
- Three weeks before an end date, each lead gets an email (Cloudflare Email Service, the family's email path) with
  a link to their review.
- On the end date a daily job in each app marks the row expired, takes the email off the allow list and frees the
  seat, all audited. Renewing later puts it back.
- Cloudflare's own seat expiration (one month to a year of inactivity, checked daily) stays on as a backstop for
  anyone the sync missed (Cloudflare, Seat management).

## The Cloudflare sync

Each app with staff has one Access group holding its allow list. The sync makes that group's email list equal the
app's current members, all of it at once, so the group cannot drift from the page. Every call is audited with
Cloudflare's answer, and a failure is shown and retried, never ignored.

**The calls** (Cloudflare API reference, read 2026-10-09):

| Step | Call | Permission it needs |
| --- | --- | --- |
| Set the allow list | `PUT /accounts/{account}/access/groups/{group}`, a full definition: name and `include` rules, one email rule per person (up to 1,000 rules per group; Cloudflare One account limits) | Access: Organizations, Identity Providers, and Groups Write |
| Find the removed person's seat | List the Zero Trust users and match the email to get its `seat_uid` | Access: Users Read |
| Free the seat | `PATCH /accounts/{account}/access/seats` with `[{seat_uid, access_seat: false, gateway_seat: false}]`; "Removes a user from a Zero Trust seat when both access_seat and gateway_seat are set to false" | Zero Trust: Seats Write |

That is the minimum: those three permissions, on this one account, nothing else. Whether the users list filters by
email was not confirmed from the docs; the build checks and falls back to paging.

**What that token can do beyond the job.** Cloudflare has no permission scoped to one group. "Groups Write" also
"grants write access to Zero Trust Organization settings" and identity providers, and "Seats Write" is described as
write access to "the number of Zero Trust seats your organization can use (and be billed for)" (Cloudflare, API
token permissions). The alternative, editing each app's policy instead of a group, needs "Access: Policies Write",
which could also rewrite Dustin's own admin policies. So the token is powerful, and the design limits where it
lives and what calls it makes:

- One holder only (DECIDE 1). Apps never hold it; they ask the holder to sync their own group.
- The holder knows each app's group by a pinned id, checks the group's name before writing, and refuses any other.
- Admin policies list Dustin's emails directly, never a group, so no sync can add anyone to an admin surface.
- Removing a seat never blocks access by itself (Cloudflare: removing a user "does not prevent" access), so a
  wrong seat call costs one seat until next sign-in, nothing more. The allow list and the app's own check are what
  keep people out.

## Primary Owner and continuity

The Primary Owner's email is a deployment value in each app, `PRIMARY_OWNER_EMAIL`, set with `wrangler secret put`
so it stays out of public repositories. No page can change it, and changing it needs the Cloudflare account.

If Dustin cannot act: his wife, using her own Cloudflare and GitHub access (set up as a separate step, not part of
this build), sets `PRIMARY_OWNER_EMAIL` to her email in each app, adds herself to each admin policy, and from then
on is the Primary Owner everywhere. Until then she manages every app as an Owner. The list of apps and where each
value lives belongs in a continuity runbook written when the second app adopts.

## Shared code

| Piece | Home | What it holds |
| --- | --- | --- |
| Access check | site-runtime `./access` | The site's `verifyAccessToken`: RS256, issuer, audience, named refusals, outage thrown; jose as a peer dependency (site-runtime has none today, and every app ships jose). |
| Layers and permissions | site-runtime `./members` | The two management rules, the end-date rules, the audit row shape. Each app passes its own titles and bundles. Tested once there. |
| Sync helper | site-runtime `./access-sync` | The three Cloudflare calls above, the desired-state compare, and the name check. Small, and used only by the token holder. |
| Members page | Capsomer `people-roles` | Table, add form, title select with reason, renew, remove confirmation, history, review checklist; `permission-matrix` as its read-only view. |

Each app keeps its own `members` and `member_audit` tables in its own database and its own title list.

## Pull request order

The lab goes first and proves the whole path; the other apps follow one at a time.

1. **site-runtime:** `./access`, with a planted wrong-audience token going red.
2. **site-runtime:** `./members` and `./access-sync`, with plants: a lead granting their own layer, a bundle wider
   than the granter's, an Owner demoting the Primary Owner, a sync to a group whose name does not match.
3. **Capsomer:** `people-roles`, visual.
4. **Dustin, account step:** the lab's Access application, group and policy; one-time code only; session lengths;
   a second factor on admin applications; the sync token with the three permissions, stored with its holder.
5. **The token holder** (Capsid, if DECIDE 1 is accepted): the sync endpoint, each app's key scoped to its own
   group.
6. **dustinedwards-info:** `members` and `member_audit`, the `/lab` gate, `PRIMARY_OWNER_EMAIL`, the lab's titles,
   `/lab/members`, the daily expiry job. Plants: an admin token refused at `/lab` and a lab token refused at
   `/admin`; a removed or expired member refused; a worker 404 at `/lab/members`.
7. **dustinedwards-info and Carrel:** adopt `./access` for their admin checks, no behaviour change.
8. **txasm, then Foxing, then Foxing Edu:** each defines its titles and adopts the page, one PR per app.
9. **Carrel:** `/people` on `people-roles` when it suits.

## Reserved names

Kept free so later work slots in without renames. None of the later functions is designed here.

| Name | For | Why this name |
| --- | --- | --- |
| `/lab`, `/lab/members` | Lab staff area, members page (built first) | Held free by the KB design. |
| `/lab/inventory`, `/lab/runs` | KB lot, location and run screens | The KB plan's nouns. |
| `/lab/studies` | Research lab function | Carrel already uses "projects". |
| `/lab/ai` | Virtual or AI lab | Same gate, short. |
| `/lab/instruments`, `/lab/stop` | Instruments and robots; a stop control | A fixed address for an emergency. |
| `lab.dustinedwards.info` | Fallback host if two Access apps on one host conflict | Same word as the path. |
| `lab-mcp.dustinedwards.info` | AI door for lab agents | Follows `carrel-mcp`. |
| Access app `dustinedwards-lab-login` | The lab sign-in | Follows `germomics-login`. |
| Access policy `dustinedwards-lab-members` | Allows `lab-people` | Site, then who. |
| Access group `lab-people` | The lab allow list, owned by the sync | One group per app. |
| Access groups `txasm-people`, `foxing-staff`, `foxing-edu-staff` | The other allow lists | Same pattern; checked against existing names at adoption. |
| Access policy `dustinedwards-lab-service` | Service tokens for instruments and CI | Service tokens take no seat. |
| Var `PRIMARY_OWNER_EMAIL` | The Primary Owner, per app | Says what it is. |
| Tables `members`, `member_audit` | Each app's list and history | Same in every app, so the shared code fits all. |
| Tables `kb_lots`, `kb_locations`, `kb_runs` | Inventory and runs | The KB plan's names. |
| Tables `lab_actors`, `lab_instruments`, `lab_approvals`, `lab_studies` | Non-human actors, instruments, approvals for physical runs, studies | One noun each. |
| Titles `primary_owner`, `owner` | Layers 0 and 1 in every app | The ruling's words. |
| Actor ids `agent:<name>`, `instrument:<name>`, `robot:<name>` | Non-human actors in audit rows | Capsid's and Carrel's form. |
| Capsomer `people-roles` | The members page | The ruling's name. |
| Capsomer `run-record`, `stop-control`, `actor-badge` | Run provenance, stop control, actor mark | Approvals reuse `approval-sheet`. |
| Capsid namespace `lab` | Lab automation agents | Per-area namespaces. |

Later, per the ruling and not designed here: passkeys before anything in the lab can trigger a physical action, and
a second approver for payments in txasm.

## Sources

Cloudflare, read 2026-10-09, under https://developers.cloudflare.com:
`/cloudflare-one/integrations/identity-providers/one-time-pin/`,
`/cloudflare-one/access-controls/access-settings/session-management/`,
`/cloudflare-one/access-controls/policies/mfa-requirements/`,
`/cloudflare-one/team-and-resources/users/seat-management/` (and its included "remove user" section, read from the
`cloudflare-docs` repository), `/cloudflare-one/account-limits/`, `/fundamentals/api/reference/permissions/`,
`/api/resources/zero_trust/subresources/access/subresources/groups/methods/update/`,
`/api/resources/zero_trust/subresources/seats/methods/edit/`.

## DECIDE

The ruling settled sign-in, layers, owners, expiry and the members page. Still open:

1. **Who holds the sync token.** One holder that apps call with their own key, or a copy in each app.
   **Recommend Capsid as the one holder:** it is already the family's credential boundary, and one copy of a
   powerful token is safer than four.
2. **Groups or policies.** Sync an Access group per app (token needs "Groups Write", which also reaches
   organization settings and identity providers) or edit each app's policy ("Policies Write", which also reaches
   the admin policies). **Recommend groups**, with the limits above.
3. **Global session of one month.** Needed for one-month sessions; admin applications keep shorter policy sessions.
   **Recommend yes.**
4. **Dustin's second factor.** **Recommend a security key, with an authenticator app as backup**, on every admin
   application.
5. **Term dates.** The Owner enters each app's semester or term end dates yearly, and reviews open three weeks
   before. **Recommend yes.**
6. **Where lab managers edit protocols** (open since PR #304). The KB editor in `/lab` with draft-only saves and
   publishing in `/admin/kb`, or Carrel with its procedure handler kept. **Recommend the KB editor in `/lab`**, per
   the 2026-10-07 ruling that procedures are structured, not writing.
