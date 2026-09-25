// Types for the agent minter, so test/mint-agents.test.ts type-checks under
// tsconfig.test.json (noImplicitAny). The runtime is scripts/mint-agents.mjs.
export const ORIGIN_DEFAULT: string;
// `repos` is OPTIONAL on an AGENTS entry and required on the wire. It is absent in
// the list and filled in by main() from the live namespace mapping before anything
// is minted, because a repos axis copied into this file would be a second copy of
// the authorization boundary. See parseNamespaceRepos.
export const AGENTS: Array<{
  name: string;
  kind: string;
  namespaces: string[];
  repos?: string[];
  grants: string[];
  flags?: Record<string, boolean>;
}>;
export function keyDir(): string;
export function keyPath(name: string): string;
export function fingerprint(key: string): string;
// A NAMED ROLE. Separate from AGENTS because it is asked for by name rather than
// selected by namespace; see the comment over ROLES in the .mjs.
export const ROLES: Array<{
  name: string;
  kind: string;
  namespaces: string[];
  repos: string[];
  grants: string[];
  tools?: string[];
  flags?: Record<string, boolean>;
  what: string;
}>;
export function roleMintCommand(role: (typeof ROLES)[number]): string;
// `registered` is the namespaces the Capsid store actually knows, fetched by the
// caller and passed in so selection stays pure. Omitting it keeps the old
// behaviour: only AGENTS matches, which is the direction that cannot widen a mint.
// `role` selects by name from ROLES instead, and the return type is the union
// because the two lists are different shapes and pretending otherwise would hide a
// missing axis at the call site that mints.
export function selectAgents(
  namespace?: string,
  registered?: string[],
  role?: string
): Array<(typeof AGENTS)[number] | (typeof ROLES)[number]>;
export function driverFor(namespace: string): (typeof AGENTS)[number];
export function parseNamespaces(text: string): string[];
// The namespace-to-repos mapping as the `namespaces` tool serves it, and the lookup
// that turns one namespace into a driver's repos axis. reposForNamespace THROWS for
// a namespace that maps to nothing rather than returning an empty list, so a mint
// cannot fall back to the wildcard by accident.
export function parseNamespaceRepos(text: string): Map<string, string[]>;
export function reposForNamespace(map: Map<string, string[]>, namespace: string): string[];
// Creates the key file, mints into it, and returns the report line. Never prints the key.
export function mintInto(
  tool: (name: string, args: object) => Promise<string>,
  agent: { name: string; what?: string },
  path: string
): Promise<string>;
export function parseArgs(argv: string[]): {
  apply: boolean;
  namespace: string | undefined;
  role: string | undefined;
  roles: boolean;
};
