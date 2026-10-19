import { useEffect, useState } from "react";
import { Empty, Spinner } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { useApp } from "../app/ctx";
import { fetchSharedCode } from "../lib/api";
import { ago, ms } from "../lib/format";
import type { SharedCodeApp, SharedCodePackage, SharedCodeView } from "../types";
import { St } from "../ui/icons";

// SHARED CODE (job_584b4e7f2824): how far the centralization has got. One panel per shared
// package from configuration (shared_packages), each app that uses it with the tag it
// pins and how many releases behind it is, and the known local copies still in the apps.
// Read from GET /portal/api/shared-code, which reads the repos through the GitHub App and
// keeps the answer for an hour. Nothing here changes anything. The Packages view (npm
// statistics) stays as it is.

type Load = { data: SharedCodeView | null; loading: boolean; error: string | null };

export function SharedCode() {
  const { now, signOut } = useApp();
  const [load, setLoad] = useState<Load>({ data: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    void fetchSharedCode().then((r) => {
      if (!alive) return;
      if (r.kind === "ok") return setLoad({ data: r.value, loading: false, error: null });
      if (r.kind === "signed-out") return signOut();
      setLoad({ data: null, loading: false, error: r.kind === "refused" ? `HTTP ${r.status}: ${r.message}` : r.message });
    });
    return () => {
      alive = false;
    };
  }, [signOut]);
  const data = load.data;
  return (
    <div className="embedded">
      {load.loading ? (
        <div className="loading">
          <Spinner label="Reading the shared packages" />
        </div>
      ) : load.error ? (
        <p role="alert">
          <St kind="crit">Could not read the shared packages: {load.error}</St>
        </p>
      ) : !data || !data.configured ? (
        <Empty kind="nothing-yet" title="No shared package is configured.">
          {data?.error ?? "Shared packages are configuration (shared_packages); none is listed yet."}
        </Empty>
      ) : (
        <>
          {data.packages.map((p) => (
            <PackagePanel key={p.name} pkg={p} />
          ))}
          {/* What was read, at the foot: a view's heading stands alone (design D13). */}
          <p className="faint shared-read">
            Read {ago(ms(data.generated), now)} from {data.apps_read} {data.apps_read === 1 ? "app" : "apps"}
            {data.apps_failed.length ? `; ${data.apps_failed.length} could not be read: ${data.apps_failed.map((a) => `${a.namespace} (${a.error})`).join("; ")}` : ""}. Kept for an hour.
          </p>
        </>
      )}
    </div>
  );
}

function behindText(u: SharedCodeApp): { kind: "ok" | "warn" | "nodata"; text: string } {
  if (u.behind === null) return { kind: "nodata", text: u.pinned ? "Not a release" : "Unpinned" };
  if (u.behind === 0) return { kind: "ok", text: "Current" };
  return { kind: "warn", text: `${u.behind} ${u.behind === 1 ? "release" : "releases"} behind` };
}

// The release line (Capsid improvement list, item 13): the version in the repo's
// package.json, whether it has a tag yet (the daily maintenance pass makes it), and npm's
// latest, so the panel says tagged, on npm, and behind. A private package says nothing
// about npm.
function ReleaseLine({ pkg }: { pkg: SharedCodePackage }) {
  // The repo's tags failing already says the repo could not be read; its package.json
  // failing too says nothing new.
  if (pkg.manifest_error && pkg.tags_error) return null;
  if (pkg.manifest_error) {
    return (
      <>
        {" · "}
        <St kind="nodata">{pkg.manifest_error}</St>
      </>
    );
  }
  if (!pkg.version) return null;
  // One span, so its words flow inline where the header lays its parts out as flex items.
  return (
    <span>
      {" · "}package.json <span className="mono">{pkg.version}</span>
      {pkg.untagged && (
        <>
          {" · "}
          <St kind="warn">untagged</St>
        </>
      )}
      {!pkg.private && (
        <>
          {" · "}
          {pkg.npm_latest ? <>npm <span className="mono">{pkg.npm_latest}</span></> : <St kind="nodata">{pkg.npm_note ?? "npm not read"}</St>}
        </>
      )}
    </span>
  );
}

function PackagePanel({ pkg }: { pkg: SharedCodePackage }) {
  const id = `shared-${pkg.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const summary = [`${pkg.users.length} ${pkg.users.length === 1 ? "use" : "uses"}`, pkg.behind ? `${pkg.behind} behind` : null, pkg.local_copies.length ? `${pkg.local_left} of ${pkg.local_copies.length} local ${pkg.local_copies.length === 1 ? "copy" : "copies"} left` : null].filter(Boolean).join(" · ");
  return (
    <Panel
      flush
      title={pkg.name}
      id={id}
      section={pkg.name}
      src={
        <>
          <a href={`https://github.com/${pkg.repo}`} target="_blank" rel="noreferrer noopener">
            {pkg.repo}
          </a>
          {" · "}
          {pkg.latest ? <>newest <span className="mono">{pkg.latest}</span></> : <St kind="nodata">{pkg.tags_error ?? "No release tag"}</St>}
          <ReleaseLine pkg={pkg} />
        </>
      }
      footer={<span className="faint">{summary}</span>}
    >
      {pkg.users.length ? (
        <table className="brief shared-users">
          <caption className="sr-only">Apps that use {pkg.name}</caption>
          <thead>
            <tr>
              <th>App</th>
              <th>Pinned</th>
              <th>Status</th>
              <th className="c-where">Where</th>
            </tr>
          </thead>
          <tbody>
            {pkg.users.map((u) => {
              const b = behindText(u);
              return (
                <tr key={`${u.namespace}|${u.where}`}>
                  <td>
                    <b>{u.name}</b>
                  </td>
                  <td>
                    <span className="mono">{u.pinned ?? "none"}</span>
                    {u.via_old_name && <span className="faint"> (old repo name)</span>}
                  </td>
                  <td>
                    <St kind={b.kind}>{b.text}</St>
                  </td>
                  <td className="c-where">
                    <span className="mono">{u.where}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="faint shared-none">No app pins it yet.</p>
      )}
      {pkg.local_copies.length > 0 && (
        <ul className="shared-local" aria-label={`Local copies ${pkg.name} replaces`}>
          {pkg.local_copies.map((l) => (
            <li key={`${l.namespace}:${l.path}`}>
              <St kind={l.present === null ? "nodata" : l.present ? "warn" : "ok"}>{l.present === null ? "Not read" : l.present ? "Still there" : "Removed"}</St> <span className="mono">{l.path}</span> <span className="faint">in {l.namespace}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
