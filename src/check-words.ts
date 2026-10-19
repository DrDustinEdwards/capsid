// Pure, with no imports, so the Portal (dashboard/) bundles it too.
// What each auto-merge check that held a pull request back means, in the words the inbox
// and the Portal show Dustin (his review of 2026-10-11: the rows showed check names). A check this list
// does not know yet still shows, its underscores read as spaces.
const CHECK_WORDS: Record<string, string> = {
  paths_not_refused: "it changes a file auto-merge never merges on its own",
  paths_not_money: "it touches payment code",
  no_migration_workflow_lockfile: "it changes a migration, a workflow or a lockfile",
  paths_allowed_for_namespace: "it changes files outside what this app merges on its own",
  head_in_base_repo: "it comes from a fork",
  body_names_job: "its description names no job",
  pr_author_allowed: "its author may not merge without you",
  job_handed_on: "its job has not handed it on yet",
  pr_recorded_for_job: "no job records it",
  base_is_default_branch: "it does not target the default branch",
  size_within_cap: "it is too large to merge unread",
  ci_green: "its checks are not green",
  head_moved: "a push landed after it was judged",
  unit_suspended: "its merge unit is suspended",
  visual_awaits_look: "it changes what people see, so it waits for your look",
  namespace_paused: "its app is paused",
  changes_existing_test: "it changes an existing test",
  pr_is_draft: "it is still a draft",
};

export function checkWords(failed: string): string {
  return CHECK_WORDS[failed] ?? failed.replace(/_/g, " ");
}
