# Portfolio audit, 2026-10-21

The nineteen reports on `review/grok-audit-2026-10-21`, file `audits/grok-2026-10-21.md`, were read. Where a cross-repo claim depends on the wording, the finding body was read again: devkit DK-1 and DK-2, site-runtime SR-1 and SR-2, site-api SA-1 through SA-3, d1-dump DD-1 and DD-2, capsomer CM-1. Product code was not re-audited. Counts below are the counts those reports already published. Nothing here reopens a finding or moves one into a different repo.

Across the nineteen reports: 1 critical, 53 major, 162 minor. A large share of the majors are one GitHub setting and one devkit job, repeated once per caller. The fifteen fixes below are that shorter list.

`capsid/conventions.md` (id 252, updated 2026-10-21) says there are no portfolio-wide rules left, and that each repo's own `CLAUDE.md` holds its rules. There is no section 5.4. `claude-skills-private` still cites section 5.4 of that file (CP-1).

## 1. Trust between repos

Capsid is the trust root. It holds grants, the GitHub App, auto-merge, and the bench routes. A merge to its default branch deploys (CA-1), and that branch requires a pull request with zero reviews and no status check. CA-3 lets a write-grant caller complete a queued job by naming any pull request on a mapped repo. CA-5 serves `resources/list` and `prompts/list` without `checkScope`. Those three are how a Capsid caller, or a stolen write grant, reaches every other repo Capsid maps.

Carrel, the site admin MCPs, and capsid-bench call Capsid with bearer keys. capsid-bench keeps `BENCH_DRIVER_KEY` out of the agent container and gives the agent only `CAPSID_RUN_KEY`. If Capsid is down, a bench run does not open and a Carrel publish does not land. If Capsid is compromised, those keys authenticate to the compromised service, and the bench seal still depends on Capsid recording the ciphertext hash. The bench report did not re-test Capsid's `/bench/start` or `/bench/score`.

Sites call `@dustinedwards/site-api` for content, media, and mentions. The 2026-10-21 site commits that say so pin v0.7.1: carrel, foxhound, foxing, dustinedwards-info, germomics, txasm. The package authenticates the caller and is the upload and frontmatter gate. SA-1 is an SVG byte check a hostile file passes. SA-2 writes tags such as `yes` and `on` into frontmatter in a form YAML readers coerce. A compromised or simply buggy site-api is a bug in every site that renders what it stored. Germomics runs site-api's conformance suite in its own tests. That suite does not catch SA-1 or SA-2. The stale-mention check (SA-10) accepts a 409 without reading the row again.

`@dustinedwards/site-runtime` builds and grades security headers. Sites that run `check-security-headers` inherit SR-1: `extraDirectives` can add `script-src-elem 'unsafe-inline'`, and the check still passes. The builder's own script rules do not apply to that channel. txasm vendors an old PDF.js and does not put the shared header set on HTML (TX-1) even though the helpers are installed. bsw applies the shared set to Worker responses and then a local CSP. A site-runtime fix reaches the next install. It does not reach a page that never calls the helper.

`@dustinedwards/d1-dump` is the nightly backup. DD-1 pages with `LIMIT` after a `MAX(id)` batch, and a `pageRows` of 0 drops rows while the marker can still look finished. txasm pins v0.5.0 and does not pass `pageRows`, so it stays on the default. Any caller that passes 0 hits the bug. The backup account is the same Cloudflare account as the database for the sites that were checked. carrel's copy step into a second bucket is the one that was filed (CR-6), and it is missing. If d1-dump is down, the cron fails. germomics `/health` showed a dump from the morning of that audit. A green health route is not a guarantee for the other sites.

devkit is the CI trust boundary. The called `code-map` workflow at tag `v0.7.0` (`27e0a1ca`) sets `contents: write` on the whole map job and runs the caller's install and coverage with `bash -c` (DK-1). `persist-credentials: false` does not remove `GITHUB_TOKEN` from the step. site-runtime, site-api, d1-dump, and capsomer call that workflow. Their reports each describe the token. The fix is one job split in devkit. Until then, an unprotected `main` plus that token is a push path on every caller (DK-2, SR-2, SA-3, DD-2, CM-1).

Capsomer ships publish-transition, email URL checks, and header helpers into sites. CM-2 accepts a URL with userinfo (`https://dustinedwards.info@evil.example/`). Enarratio has the same shape on links (EN-3). A bad capsomer check becomes a bad link in every site that uses the component.

claude-skills is what a driver session loads. CS-1 treats a push to the default branch, and `gh pr create`, as safe enough for the self-approval classifier. CS-3 tells the driver to `cat` a namespace key. claude-skills-private's session-start skill still says conventions.md section 5.4 wins (CP-1). A session that follows it is following a file that no longer has those rules. The public skill repo and the private one can disagree, and the private one is the one the hook prints.

capsid-bench is a client of Capsid and of GitHub Actions, not of site-api. Its `main` is unprotected while the workflows hold the OAuth token, `BENCH_KEY`, the driver key, and the second-reader key (CB-3). A push there is a push into the study, and into Capsid's bench namespace if the keys are printed. The walk refuses its own frame (CB-1), so the draw fails closed. That is a stuck study, not a leak.

If GitHub Actions is down, deploys and backups that are workflows do not run. germomics deploys on push to `main` ahead of the verify job (GE-1). julieedwards-info has no CI gate in front of Vercel (JE-1). Those two ship before the checks exist.

## 2. The same code twice, and pins that have drifted

Shared on purpose, one copy:

- Header builder and checker: site-runtime. Local header files remain in capsomer and in bsw. txasm has the package and does not use it for HTML.
- Content, media, mentions: site-api. Sites should not grow a second parser. SA-2 is the cost of the one parser being wrong.
- Backups: d1-dump. The `pageRows` path is the one implementation.
- CI workflows: devkit, pinned by sha.

Drift between the tag a caller installs and the tip that was audited:

| Package | Tag callers are told to install | Tip that was audited | What the gap is |
| --- | --- | --- | --- |
| devkit | `v0.7.0` at `27e0a1ca` | `fb92659` | Callers run the tag. DK-1 is in that tag. The tip adds a pnpm input. |
| site-runtime | `v0.7.0` | `b692578` | Sites on the tag. SR-1 is in the tag the audits read. |
| site-api | `v0.7.1` at `0760b201` | same commit | The site pins and the audit match. |
| d1-dump | `v0.5.0` at `22b84b96` | `ea46d212`, four commits ahead | README still says install the tag. The product change on main is an unexported type. DD-1 is in the dump code both sides share. |
| capsomer | `v0.10.0` at `f86b2418` | `0c895c1f`, four commits ahead | `package.json` still says 0.10.0. Email, publish-transition, security-headers, and the worker are unchanged since the tag. The tag's workflows still pin devkit `v0.6.0`. Main's workflows pin `v0.7.0`. prelum pins the tag commit. |
| enarratio | npm `latest` is `0.1.0-alpha.8`. npm `next` and tag `v0.3.1` are `c82a9aeb` | `2f856131`, sixteen commits ahead, `package.json` still `0.3.1` | Installers of the version number do not get the audited commit. The gallery workflow for the tip did deploy. |
| prelum | tag `v0.3.0` at `a886103b` | `e2d45054`, five commits ahead | README installs the tag. The audit is the tip. |

Duplicated logic that is not a shared package yet:

- URL userinfo. capsomer `checkUrl` (CM-2) and enarratio `safeHref` (EN-3) both miss `user@host`. One allowlist of schemes plus a ban on username and password belongs in one module. They are different runtimes (email HTML, SVG and HTML output), so a shared function is a small extract, not a new package.
- CSP grading. site-runtime's check, its OSHP suite, and each site's local header file can disagree (SR-3, TX-1, BS-4). The grade should be the builder's output, and `extraDirectives` should not be a side door (SR-1).
- "Is this main protected?" is re-discovered in almost every report. It is one org checklist, not nineteen patches.
- MCP server and SDK advisories are filed in capsid, carrel, foxhound, and dustinedwards-info. Each lockfile upgrades on its own. The version floor is one decision: `@modelcontextprotocol/server` at least 2.3.0, `@modelcontextprotocol/sdk` at least 1.32.0, and `maxToolInputElements` set where `buildServer` exists (CA-2, CR-2, FH-4, DE-4).

## 3. Conventions that differ for no reason

Default branch is `main` except claude-skills and claude-skills-private, which use `master`. The skill classifier has to name both (CS-1). One name would shrink that list.

License files: MIT in the public packages that have one, `UNLICENSED` in devkit and site-runtime (public repos, private packages, stated as intentional), no `LICENSE` file in capsomer and carrel. A public repo without a license file is the odd one.

Actions pinning: most workflows pin `uses:` to a commit. claude-skills checks out by tag (CS-8). capsid-bench leaves `sha_pinning_required` false. devkit's own called workflows are pinned by callers, which is the pattern worth keeping.

`npm audit` in CI is present in some sites and absent in the shared packages (SA-5 and SA-6, DD-3, CA-12, EN-5). The shared packages are where a high advisory becomes everyone's advisory.

`CLAUDE.md` is required by the one remaining convention and is missing in prelum, claude-skills, claude-skills-private, and capsid-bench. Other repos were not all re-checked for the file in this pass. The ones that were filed are enough to show the convention has no check.

Node and package-manager pins differ per repo (npm, pnpm, a Node 26 image in capsid-bench, Node 24 on the machine that ran several suites). That is reasonable per app. The unreasonable split is a tag named `v0.3.1` that is not the commit `package.json` calls `0.3.1` (enarratio, and the same shape on d1-dump and capsomer where main moved and the version did not).

## 4. One problem, filed many times

**Unprotected default branch, often with a `contents: write` job.** DK-2, SR-2, SA-3, DD-2, CM-1, EN-1, CR-1, FH-3, FX-6, PL-1, CS-4, CB-3. DE-2 is the case where security updates merge themselves and `main` then deploys. CA-1 is the case where a pull request is required and a review is not, and the merge deploys. CP-2 is the private plan where branch protection is unavailable and a bot already merged. GE-1 and JE-1 are the deploy that does not wait for CI. One fix: protect the branch, require the CI check, and stop automerge until that protection exists. devkit's Renovate preset already turns `platformAutomerge` on and notes that it does nothing without protection (DK-2). Turning protection on changes that preset from a no-op into a merger. Do the protection and the automerge review as one change, not as a surprise.

**The devkit map job.** DK-1 is the bug. SR-2, SA-3, DD-2, CM-1, and CA-13 are callers. Splitting measure (`contents: read`) from publish (`contents: write`, artifact in) closes the caller findings. Do not patch each caller workflow to work around it.

**MCP advisories.** CA-2, CR-2, FH-4, DE-4. One version floor, four lockfiles.

**Header trust.** SR-1 is the package bug. TX-1 and the bsw asset path (BS-4) are sites that never ask the package. Fix the package, then point those responses at it.

**Backup completeness.** DD-1 is the pager. CR-6 is the copy living in the same account. They stay two fixes. They are the same backup story.

**Instruction files that outlived the convention cut.** CP-1 cites section 5.4. CS-2 marks live gates in `/improve` as calibration. CS-3 prints a key with `cat`. One pass over the skill files after conventions.md was emptied.

**Machine failure scored as a product failure.** capsid-bench CB-2 (docker did not start, hidden tests reported failed) is local to that repo. devkit DK-3 (a tool that throws still exits 0) is the opposite failure. They are not one patch. They are the same habit: the exit code and the sentence in the header disagree. Mentioned so they are not merged by mistake.

## 5. Fifteen fixes, ranked

1. Protect every default branch that deploys or holds workflow secrets. Require the CI check. Review automerge in the same week, because devkit's Renovate preset will start merging once protection exists. Closes the family in section 4, including CA-1's missing review and status check. CP-2 cannot use branch protection on the current private plan. There the fix is to stop the GitHub App from merging alone.
2. Split devkit `code-map` into a read job and a publish job (DK-1). Re-pin callers to that sha. This removes `GITHUB_TOKEN` from `bash -c` on site-runtime, site-api, d1-dump, capsomer, and capsid's code-map.
3. Foxing FX-1. One private-club check on every child read and on `joinClub`, and stop writing a private club id onto a public activity row. This is the only critical finding in the nineteen reports.
4. Capsid CA-3. A write grant must not complete a queued job by naming an arbitrary pull request on a mapped repo.
5. site-runtime SR-1. Refuse `extraDirectives` that reopen `script-src`, `script-src-elem`, `worker-src`, `form-action`, or `frame-ancestors`, and make the checker apply the same rules. Then txasm HTML and bsw asset responses should call that helper (TX-1, BS-4).
6. Foxhound FH-1 and FH-2. Rethrow from the claim helpers unless the error is the unique index, so Stripe retries. Retry the credit note until the fee is credited.
7. dustinedwards-info DE-1. An empty post listing must not delete every post row and report success.
8. d1-dump DD-1. A page size of 0, or a page query that returns fewer rows than the id window, must fail the backup. Ship it as a new tag and move the README off a tag that does not contain the fix.
9. site-api SA-1 and SA-2. Reject SVG that is not a small XML image, and stop writing YAML boolean words as bare tags. Add both to the conformance suite germomics already runs.
10. Upgrade `@modelcontextprotocol/server` to at least 2.3.0 and `@modelcontextprotocol/sdk` to at least 1.32.0 in capsid, carrel, foxhound, and dustinedwards-info. Set the tool-input element cap (CA-2, CR-2, FH-4, DE-4).
11. Capsid CA-5. `resources/list` and `prompts/list` call `checkScope`.
12. Germomics GE-2 and GE-3. Refuse preview tokens when `BETTER_AUTH_SECRET` is unset. Sanitize page HTML on save.
13. capsid-bench CB-1. Put the missing digit back in `FRAME_SHA256` and test it against the blob. The walk cannot take a step until that matches. CB-2 (docker failure reported as failed tests) is the next line in that repo, and it is not this fix.
14. claude-skills CS-1, CS-2, and CS-3, together with CP-1. The classifier refuses a default-branch push and an open-ended `gh pr create`. `/improve` stops treating live gates as calibration and stops printing `cat` of a key. The private session-start skill points at each repo's `CLAUDE.md` and drops the section 5.4 cite.
15. Enarratio, d1-dump, and capsomer version tags. A published version number is the commit that number names. Stop `bump-consumers` on a tag that is not the audited tip (EN-9, EN-7), and cut tags when main moves so installers of `#v0.10.0` and `#v0.5.0` are not four commits behind the workflows.

## 6. Grade per repo

These are the maintainability grades the repo reports printed, except claude-skills-private, whose report has no letter. Majors in the CI family do not by themselves lower a grade that was about the shape of the code.

| Repo | Grade | One line |
| --- | --- | --- |
| devkit | B | Small tools and a dangerous called workflow. Split the map job and make a missing tool fail the process. |
| site-runtime | B | One header module. The checker and the builder disagree on `extraDirectives`. |
| site-api | B | The shared content gate. SVG and tag coercion are the holes in an otherwise single implementation. |
| d1-dump | A | The backup tool is small and readable. The pager bug and the unprotected branch are why it is not finished. |
| capsomer | A | Components are split cleanly. The release tag still pins an older devkit workflow. |
| enarratio | B | Renderers are tested against a DOM parse. The version people install is not the commit that was audited. |
| capsid | B | The grant and snapshot design holds. Reviews, scope on list, and the job-complete path are the gaps. |
| carrel | B | Loaders and views are followable. MCP advisories and branch protection are inherited, not local design. |
| foxhound | B | The money object and the Stripe checks are the strong part. Swallowed claim errors and route length hold it at B. |
| foxing | B | Web, core, and api are a clear split. The private-club check is missing on a real read path. |
| dustinedwards-info | B | The operator surface is understandable. An empty listing that deletes posts is the one that matters. |
| germomics | B | Access fails closed and the backup check is real. Preview tokens and stored HTML keep it off A. |
| julieedwards-info | B | One content module and a clean lockfile. Production can deploy with no CI in front of it. |
| txasm | B | Roles and the data-access lint are the right boundary. Headers, sponsor URLs, and PDF.js are the holes. |
| bsw | C | Typed routes, and no tests. Public claims have three sources, and the pages describe a product the site does not run. |
| prelum | B | The markdown path is safe by construction and hashed. `main` is open, and datetimes ignore the zone cases. |
| claude-skills | C | The hooks fail closed and the tests bite. The classifier and `/improve` still allow the moves they exist to stop. |
| claude-skills-private | C | The report prints no letter. The hook's skill cites a deleted rule, and nothing on `master` has to pass a check. |
| capsid-bench | B | The scorer, the proxy, and the seal are careful and tested. The frame hash does not match the file, so the walk cannot step. |

## What to keep across the portfolio

The shared packages are real. Sites pin site-api v0.7.1 and site-runtime v0.7.0 by commit, and the backup call sites that were checked use d1-dump rather than a pasted dump. devkit is how CI is shared, which is why one job split fixes several reports. Secret scanning is already on for several public repos, including the shared packages. Foxhound's money object, germomics' fail-closed access, txasm's role boundary, prelum's hashed markdown, and capsid-bench's claim parser and seal are local designs worth leaving alone while the fifteen fixes land.

## Could not check

- Live branch protection was not re-queried for all nineteen during this portfolio pass. Each report's API result stands.
- Whether Renovate has merged a pull request since those audits. DK-2 left that unchecked. DE-2 says dustinedwards-info's security updates do merge.
- Capsid bench routes against capsid-bench's client. Judged from each repo's own report.
- A full re-read of every source file. This document is the cross-repo reading of the nineteen reports, plus the shared-package finding bodies named above.
