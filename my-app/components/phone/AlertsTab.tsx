"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card } from "@/components/ui";
import { useOrgHref } from "@/hooks/useOrg";
import {
  readAlertsState,
  sendTestAlert,
  turnAlertsOff,
  turnAlertsOn,
  type AlertsState,
} from "@/lib/phone-push-client";
import { ErrorNote, Meta } from "./parts";

const STATE_TEXT: Record<AlertsState, string> = {
  unsupported: "This browser cannot show alerts. Try another browser on this device.",
  "needs-install":
    "On an iPhone or iPad, alerts only work from the Home Screen. In Safari, tap Share, then Add to Home Screen, and open Schema Studio from there.",
  unavailable: "Alerts belong to a signed-in account, and this copy of the app has none.",
  denied:
    "Alerts are blocked for this site. Allow them for this site in this device's settings, then come back.",
  off: "Alerts are off on this device.",
  on: "Alerts are on for this device.",
};

function reasonFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function testResult(sent: number, failed: number): string {
  if (sent > 0 && failed === 0) return sent === 1 ? "Sent to 1 device." : `Sent to ${sent} devices.`;
  if (sent > 0) return `Sent to ${sent}. ${failed} could not be reached.`;
  if (failed > 0) return "No device could be reached. Turn alerts off and on again.";
  return "No device has alerts on.";
}

export default function AlertsTab() {
  const orgPath = useOrgHref();
  const [state, setState] = useState<AlertsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    readAlertsState()
      .then((next) => {
        if (current) setState(next);
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setError(reasonFor(failure, "Could not read the alert settings."));
        setState("off");
      });
    return () => {
      current = false;
    };
  }, []);

  async function working(step: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    setTestNote(null);
    try {
      await step();
    } catch (failure) {
      setError(reasonFor(failure, fallback));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-4">
        <div className="text-[14px] font-semibold">Alerts on this device</div>
        <div className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
          {state === null ? "Checking…" : STATE_TEXT[state]}
        </div>

        {error && (
          <div className="mt-2">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {state === "off" && (
          <div className="mt-3">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                working(async () => setState(await turnAlertsOn()), "Could not turn alerts on.")
              }
            >
              Turn on
            </Button>
          </div>
        )}
        {state === "on" && (
          <div className="flex flex-wrap gap-2 mt-3">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                working(async () => {
                  const { sent, failed } = await sendTestAlert();
                  setTestNote(testResult(sent, failed));
                }, "Could not send a test alert.")
              }
            >
              Send a test alert
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                working(async () => {
                  await turnAlertsOff();
                  setState("off");
                }, "Could not turn alerts off.")
              }
            >
              Turn off
            </Button>
          </div>
        )}
        {testNote && <div className="text-[13px] mt-2">{testNote}</div>}
      </Card>

      <Card className="p-4">
        <div className="text-[14px] font-semibold">What you get alerted about</div>
        <ul className="text-[13px] mt-1 list-disc pl-4" style={{ color: "var(--text-2)" }}>
          <li>A tracked schema drifts, changes again, goes back in sync, or stops or starts being reachable</li>
          <li>A run is waiting for your approval</li>
          <li>Your own run is approved or rejected</li>
          <li>Someone asks for access, if you can answer them</li>
          <li>Your own request is answered</li>
        </ul>
        <Meta>Alerts name a schema or a script, never a database address or any SQL.</Meta>
      </Card>

      <div className="text-[13px]">
        <Link href={orgPath("/studio")} style={{ color: "var(--brand)" }}>
          Open the full site
        </Link>
      </div>
    </div>
  );
}
