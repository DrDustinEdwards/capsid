import { useState } from "react";
import { useApp } from "../app/ctx";
import { fetchPush, postPush, queryClient, useAnswer, type Answer, type PushOp } from "../lib/api";
import { BASE } from "../lib/base";
import { ago, msSql } from "../lib/format";
import type { PortalPush } from "../types";
import { Panel } from "capsomer/react/panel";

// Phone alerts (src/push.ts; docs/design/design-merge-pipeline.md section 5): turn Web
// Push on for this browser, list the devices that have it, turn one off, send a test.
// Loaded on its own after Settings' first paint, so it adds nothing to the initial
// script. The alert itself is shown by dashboard/public/sw.js.

const PUSH_KEY = ["push"];

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** "Chrome on Android": enough to tell two devices apart, and nothing more. */
function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "this device";
  return `${browser} on ${os}`;
}

export function PhoneAlerts() {
  const { feed, now, signOut } = useApp();
  const load = useAnswer(PUSH_KEY, fetchPush);
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

  const turnOn = async () => {
    if (!data?.public_key) return;
    setBusy(true);
    setNote(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        setNote({ kind: "crit", text: "This browser did not allow notifications. Allow them for this site in the browser's settings, then try again." });
        return;
      }
      const reg = await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: data.public_key }));
      take(await postPush(feed.csrf, { op: "on", subscription: sub.toJSON(), label: deviceLabel(navigator.userAgent) }), "Phone alerts are on for this device.");
    } catch (e) {
      setNote({ kind: "crit", text: `Alerts were not turned on: ${e instanceof Error ? e.message : String(e)}` });
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
            Six things only: a money pull request waiting over 2 hours, a rollback, a job at the correction cap, a question over 4 hours old on a job with priority 70 or more, auto-merge paused by the safety shutoff, and a visual pull request waiting for your look. Everything else waits for the daily digest and Needs you. An alert names the repo and number, never a title, and a tap
            opens that item in the Portal; it has no Approve button.
          </p>
          {data?.problem && (
            <div className="callout warn" role="status">
              Not set up yet: {data.problem}
            </div>
          )}
          {note && (
            <div className={note.kind === "crit" ? "callout crit" : "callout"} role={note.kind === "crit" ? "alert" : "status"}>
              {note.text}
            </div>
          )}
          <div className="toolbar">
            {supported() ? (
              <button type="button" className="btn primary" disabled={busy || !data?.public_key} onClick={() => void turnOn()}>
                Turn on for this device
              </button>
            ) : (
              <span className="faint">This browser cannot receive Web Push.</span>
            )}
            <button type="button" className="btn" disabled={busy || devices.length === 0 || !data?.public_key} onClick={() => void send({ op: "test" }, "Test alert sent to each device.")}>
              Send a test alert
            </button>
          </div>
          {devices.length > 0 && (
            <ul className="device-list">
              {devices.map((d) => (
                <li key={d.id} className="prefrow">
                  <span>
                    {d.label ?? `Device ${d.id}`}{" "}
                    <span className="faint">
                      turned on {ago(msSql(d.created_at), now)}
                      {d.last_sent_at ? `, last alert ${ago(msSql(d.last_sent_at), now)}${d.last_status && (d.last_status < 200 || d.last_status > 299) ? ` (answered ${d.last_status})` : ""}` : ", no alert yet"}
                    </span>
                  </span>
                  <button type="button" className="btn ml-auto" disabled={busy} onClick={() => void send({ op: "off", id: d.id }, `Alerts are off for ${d.label ?? `device ${d.id}`}.`)}>
                    Turn off
                  </button>
                </li>
              ))}
            </ul>
          )}
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
          One email a day after {digest.hour_utc}:00 UTC: pull requests waiting on you by class, questions, blocked jobs, rollbacks, and what finished or became ready since the last one.
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
            {digest.last.outcome === "sent" ? "Last sent" : "Last attempt failed"} {ago(Date.parse(digest.last.at), now)}: {digest.last.note}
          </p>
        )}
      </div>
    </Panel>
  );
}
