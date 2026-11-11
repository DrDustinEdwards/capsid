import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PUSH_KEY } from "../lib/keys";
import { useApp } from "../app/ctx";
import { fetchPush, postPush, useAnswer, type Answer, type PushOp } from "../lib/api";
import { BASE } from "../lib/base";
import { ago, msSql } from "../lib/format";
import type { PortalPush } from "../types";
import { Panel } from "capsomer/react/panel";
import { PushDevices } from "capsomer/react/web-push";
import "capsomer/web-push.css";
import "capsomer/button.css";

// Phone alerts (src/push.ts; docs/design/design-merge-pipeline.md section 5): turn Web
// Push on for this browser, list the devices that have it, turn one off, send a test.
// Loaded on its own after Settings' first paint, so it adds nothing to the initial
// script. The alert itself is shown by Capsomer's push worker (capsomer/push-sw.js), which the
// build writes as sw.js (vite.config.ts).

export function PhoneAlerts() {
  const { feed, now, signOut } = useApp();
  const load = useAnswer(PUSH_KEY, fetchPush);
  const queryClient = useQueryClient();
  const data = load.data;
  const [busy, setBusy] = useState(false);
  const [said, setNote] = useState<{ kind: "ok" | "crit"; text: string } | null>(null);
  const note = said ?? (load.error ? { kind: "crit" as const, text: load.error } : null);

  // A change answers the devices as they are now, which replaces the read.
  const take = (r: Answer<PortalPush>, ok: string) => {
    if (r.kind === "ok") {
      queryClient.setQueryData(PUSH_KEY, r.value);
      setNote({ kind: "ok", text: ok });
    } else if (r.kind === "signed-out") signOut();
    else setNote({ kind: "crit", text: r.message });
  };

  const send = async (body: PushOp, ok: string) => {
    setBusy(true);
    setNote(null);
    try {
      take(await postPush(feed.csrf, body), ok);
    } finally {
      setBusy(false);
    }
  };

  // PushDevices asks for permission and subscribes; the server stores what it sends here.
  const turnOn = async (subscription: PushSubscriptionJSON, label: string) => {
    setBusy(true);
    setNote(null);
    try {
      take(
        await postPush(feed.csrf, { op: "on", subscription, label }),
        "Phone alerts are on for this device.",
      );
    } finally {
      setBusy(false);
    }
  };

  const devices = data?.devices ?? [];
  return (
    <>
      <Panel flush title="Phone alerts" count={devices.length} src="Web Push">
        <div className="body stack-gap">
          <p className="faint">
            Six things only: a money pull request waiting over 2 hours, a rollback, a job at the
            correction cap, a question over 4 hours old on a job with priority 70 or more,
            auto-merge paused by the safety shutoff, and a visual pull request waiting for your
            look. Everything else waits for the daily digest and Needs you. An alert names the repo
            and number, never a title, and a tap opens that item in the Portal; it has no Approve
            button.
          </p>
          <PushDevices
            publicKey={data?.public_key ?? null}
            worker={`${BASE}/sw.js`}
            scope={`${BASE}/`}
            busy={busy}
            note={note}
            problem={data?.problem}
            devices={devices.map((d) => ({
              id: d.id,
              label: d.label ?? `Device ${d.id}`,
              detail: `turned on ${ago(msSql(d.created_at), now)}${
                d.last_sent_at
                  ? `, last alert ${ago(msSql(d.last_sent_at), now)}${d.last_status && (d.last_status < 200 || d.last_status > 299) ? ` (answered ${d.last_status})` : ""}`
                  : ", no alert yet"
              }`,
            }))}
            onTurnOn={turnOn}
            onTurnOff={(id) => {
              const d = devices.find((x) => x.id === id);
              void send(
                { op: "off", id: Number(id) },
                `Alerts are off for ${d?.label ?? `device ${id}`}.`,
              );
            }}
            onTest={() => void send({ op: "test" }, "Test alert sent to each device.")}
          />
        </div>
      </Panel>
      {data && <DailyDigest digest={data.digest} now={now} />}
    </>
  );
}

// The daily email digest (src/digest.ts): on or off, and why. Nothing to press: it is
// turned on by configuration once Email Routing is on.
function DailyDigest({ digest, now }: { digest: PortalPush["digest"]; now: number }) {
  return (
    <Panel flush title="Daily digest" src="email">
      <div className="body stack-gap">
        <p className="faint">
          One email a day after {digest.hour_utc}:00 UTC: pull requests waiting on you by class,
          questions, blocked jobs, rollbacks, and what finished or became ready since the last one.
        </p>
        {digest.on ? (
          <div className="callout" role="status">
            On. It goes to {digest.to}.
          </div>
        ) : (
          // Plain words first (the UX audit's m11); what the setup still needs, in the
          // Worker's own words, is one click away.
          <div className="callout warn" role="status">
            <b>Not set up yet.</b> Nothing is sent until it is.
            <details className="mt4">
              <summary>What it needs</summary>
              <p className="small">{digest.problem}</p>
            </details>
          </div>
        )}
        {digest.last && (
          <p className={digest.last.outcome === "failed" ? "callout crit" : "faint"}>
            {digest.last.outcome === "sent" ? "Last sent" : "Last attempt failed"}{" "}
            {ago(Date.parse(digest.last.at), now)}: {digest.last.note}
          </p>
        )}
      </div>
    </Panel>
  );
}
