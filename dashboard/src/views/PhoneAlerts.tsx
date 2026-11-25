import { Alert, Banner } from "capsomer/react/banner";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PUSH_KEY } from "../lib/keys";
import { useApp } from "../app/ctx";
import { fetchPush, postPush, type PushOp } from "../lib/api";
import { useAnswer, type Answer } from "capsomer/react/data";
import { BASE } from "../lib/base";
import { ago } from "../lib/format";
import { parse } from "capsomer/behavior/time";
import type { PortalPush } from "../types";
import { Panel } from "capsomer/react/panel";
import { PushDevices } from "capsomer/react/web-push";
import "capsomer/web-push.css";

export function PhoneAlerts() {
  const { feed, now, signOut } = useApp();
  const load = useAnswer(PUSH_KEY, fetchPush);
  const queryClient = useQueryClient();
  const data = load.data;
  const [busy, setBusy] = useState(false);
  const [said, setNote] = useState<{ kind: "ok" | "crit"; text: string } | null>(null);
  const note = said ?? (load.error ? { kind: "crit" as const, text: load.error } : null);

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
      <Panel flush title="Phone alerts" count={devices.length}>
        <div className="body cap-stack" data-gap="4">
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
              detail: `turned on ${ago(parse(d.created_at), now)}${
                d.last_sent_at
                  ? `, last alert ${ago(parse(d.last_sent_at), now)}${d.last_status && (d.last_status < 200 || d.last_status > 299) ? ` (answered ${d.last_status})` : ""}`
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

function DailyDigest({ digest, now }: { digest: PortalPush["digest"]; now: number }) {
  return (
    <Panel flush title="Daily digest">
      <div className="body cap-stack" data-gap="4">
        <p className="cap-text" data-tone="dim">
          Daily after {digest.hour_utc}:00 UTC.
        </p>
        {digest.on ? (
          <Banner tone="ok">On. It goes to {digest.to}.</Banner>
        ) : (
          <Banner
            tone="warn"
            title="Not set up yet."
            body={
              <details>
                <summary>What it needs</summary>
                <p className="cap-text hint" data-size="small">
                  {digest.problem}
                </p>
              </details>
            }
          />
        )}
        {digest.last &&
          (digest.last.outcome === "failed" ? (
            <Alert tone="crit">
              Last attempt failed {ago(Date.parse(digest.last.at), now)}: {digest.last.note}
            </Alert>
          ) : (
            <p className="cap-text" data-tone="dim">
              Last sent {ago(Date.parse(digest.last.at), now)}: {digest.last.note}
            </p>
          ))}
      </div>
    </Panel>
  );
}
