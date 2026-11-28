import { Suspense, lazy } from "react";
import { useApp } from "../app/ctx";
import { Panel } from "capsomer/react/panel";
import { PageTabs, useTabParam } from "../ui/pagetabs";
import { useEditor } from "capsomer/react/config-form";
import type { OpsPackageConfig } from "../types";
import { PACKAGE_TABS, tabOf } from "../app/ctx";
import { PageHead } from "./shared";

const SharedCode = lazy(() => import("./SharedCode").then((m) => ({ default: m.SharedCode })));
const Completeness = lazy(() =>
  import("./Completeness").then((m) => ({ default: m.Completeness })),
);
const PackageForm = lazy(() => import("./PackageConfig").then((m) => ({ default: m.PackageForm })));

export function Packages() {
  const tab = tabOf(PACKAGE_TABS, useTabParam()) ?? PACKAGE_TABS[0].id;
  return (
    <div className="cap-admin-page">
      <PageHead title="Packages" />
      <PageTabs label="Packages" path="/packages" tabs={PACKAGE_TABS} current={tab} />
      <div className="cap-stack" id={tab}>
        {tab === "complete" ? (
          <Suspense fallback={null}>
            <Completeness />
          </Suspense>
        ) : (
          <>
            <NpmPackages />
            <Suspense fallback={null}>
              <SharedCode />
            </Suspense>
          </>
        )}
      </div>
    </div>
  );
}

// The ops_packages rows: the npm packages the versions table reads.
function NpmPackages() {
  const { feed } = useApp();
  const ed = useEditor<OpsPackageConfig>();
  const rows = feed.live.packages;
  return (
    <>
      <div className="cap-cluster" data-gap="3">
        <button
          type="button"
          className="cap-btn"
          data-variant="primary"
          onClick={ed.add}
          disabled={ed.editing?.kind === "add"}
        >
          Add package
        </button>
      </div>
      {ed.editing && (
        <Suspense fallback={null}>
          <PackageForm key={ed.formKey} editing={ed.editing} onClose={ed.close} />
        </Suspense>
      )}
      {rows.length > 0 && (
        <Panel flush title="npm packages" count={rows.length}>
          <div className="cap-table-wrap">
            <table className="cap-table">
              <thead>
                <tr>
                  <th>npm name</th>
                  <th>GitHub repository</th>
                  <th>Formerly</th>
                  <th>
                    <span className="cap-sr-only">Controls</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((cfg) => (
                  <tr key={cfg.name} data-package={cfg.name}>
                    <td className="cap-mono">{cfg.name}</td>
                    <td className="cap-mono">{cfg.repo ?? "none"}</td>
                    <td className="cap-mono">{cfg.formerly ?? "none"}</td>
                    <td>
                      <button
                        type="button"
                        className="cap-btn"
                        aria-label={`Edit ${cfg.name}`}
                        onClick={() => ed.edit(cfg, cfg.name)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
