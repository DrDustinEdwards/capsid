# Consolidation and destructive writes

The `capsid_lint_namespace` tool runs the wiki maintenance loop. The Worker never calls an LLM. The driving client does the reasoning with the ordinary read and write tools.

- `capsid_lint_namespace(namespace, mode: "gather")` returns a read-only packet: the namespace `core.md`, the compiled `concept` and `decision` documents, every un-archived `episodic` and `source` document, and the schema and conventions.
- `capsid_lint_namespace` reads only what the caller is scoped to, with one exemption: `capsid/schema.md` and `capsid/conventions.md` are returned to every caller as its rules, whatever its scope. No other `capsid` document is read. An edge whose other end is in a namespace the caller is not scoped to is left out of gather and report, and report skips the doc-vs-code drift check when the namespace's repo is outside the caller's repo scope.
- `capsid_lint_namespace(namespace, mode: "finalize", consumed: [paths])` archives the consumed entries under an `archive/` prefix and writes one audit row. It moves and never deletes, and `gather` excludes `archive/`, so the loop is idempotent.

## Destructive writes need confirmation

`capsid_delete_doc`, `capsid_write_doc` actions `move` and `restore`, `capsid_lint_namespace` finalize, and any `capsid_write_doc` write that would overwrite an existing document ask for confirmation first. When the client supports [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation), the server sends an elicitation request and proceeds only on an explicit accept. Most Streamable HTTP clients run stateless and cannot answer server-initiated requests, so the tool rejects. Re-run it with `confirm: true`. Creating a new document never needs confirmation.

Every delete and overwrite snapshots the prior row into `document_versions` first, whatever happened at the confirmation step.
