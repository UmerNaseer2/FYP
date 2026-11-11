"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorNote, JSON_HEADERS, Meta, errorFrom } from "@/components/phone/parts";
import { PageHeader } from "@/components/studio/PageHeader";
import { Button, Card, Input } from "@/components/ui";
import { Select, type SelectOption } from "@/components/ui/Select";
import { useOrg } from "@/hooks/useOrg";
import { readUserCode } from "@/lib/agent-rules";
import { apiFetch } from "@/lib/api-fetch";
import { orgHref } from "@/lib/org-slug";
import { isOrgListing, type OrgSummary } from "@/lib/organization-list";
import { timeAgo } from "@/lib/time-ago";

const COULD_NOT_READ = "Could not read that code. Try again.";
const COULD_NOT_LINK = "Could not link that computer. Try again.";
const COULD_NOT_TURN_AWAY = "Could not turn that computer away. Try again.";
const OFFLINE = "This device could not reach the site. Check its connection and try again.";

type Finished = "linked" | "turned-away";

/** When a computer asked to be linked, as the site sent it, or null if that is not a time. */
function readTime(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

/** "14:32", on this device's clock. */
function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Where someone says yes to a computer. The desktop app opens this page and
 * shows a code in its own Settings, and the person types that code here, so
 * they link what is in front of them.
 *
 * The code is never taken from the page's address. A link that carried one
 * would let a stranger send "press Link" to a member and get their own
 * computer linked, with the organization's connection passwords. Typing the
 * code means reading it off a computer the person can see.
 *
 * Whoever holds the code can only ask. Nothing happens until someone signed in
 * says so here, which is why the page asks them to check the name and the time
 * instead of linking as soon as it opens.
 */
export default function LinkComputer() {
  const org = useOrg();
  const router = useRouter();
  const orgFieldId = useId();
  const codeFieldId = useId();
  const [typed, setTyped] = useState("");
  const code = readUserCode(typed);
  const [computer, setComputer] = useState<{ code: string; name: string; openedAt: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [others, setOthers] = useState<OrgSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<Finished | null>(null);

  // Ask which computer this code belongs to, once there is a whole code.
  useEffect(() => {
    if (code === null) return;
    let current = true;
    async function read(asked: string) {
      try {
        const response = await apiFetch(`/api/computers/link?code=${asked}`, { cache: "no-store" });
        if (!current) return;
        if (!response.ok) {
          const message = await errorFrom(response, COULD_NOT_READ);
          if (current) setProblem(message);
          return;
        }
        const body = (await response.json()) as { computerName?: unknown; openedAt?: unknown };
        if (!current) return;
        if (typeof body.computerName !== "string") {
          setProblem(COULD_NOT_READ);
          return;
        }
        setComputer({ code: asked, name: body.computerName, openedAt: readTime(body.openedAt) });
        setProblem(null);
      } catch {
        if (current) setProblem(OFFLINE);
      }
    }
    void read(code);
    return () => {
      current = false;
    };
  }, [code]);

  // The computer joins the organization this page is open in, so someone in
  // several gets to choose. Without the list they can still link it here.
  const slug = org?.slug ?? null;
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const response = await apiFetch("/api/organizations", { cache: "no-store" });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (current && isOrgListing(body)) {
          setOthers(body.organizations.filter((each) => each.slug !== slug));
        }
      } catch {
        // Unreachable, or not JSON. The picker just stays away.
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [slug]);

  function moveTo(value: string) {
    if (value === slug) return;
    // The code does not travel in the address, so it is typed again there.
    router.push(orgHref(value, "/link-computer"));
  }

  async function answer(method: "POST" | "DELETE", fallback: string, then: Finished) {
    if (code === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await apiFetch("/api/computers/link", {
        method,
        headers: JSON_HEADERS,
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        setProblem(await errorFrom(response, fallback));
        return;
      }
      setFinished(then);
    } catch {
      setProblem(OFFLINE);
    } finally {
      setBusy(false);
    }
  }

  // The name on screen has to be the name for the code on screen. An answer
  // for the code someone just changed is not one.
  const shown = computer !== null && computer.code === code ? computer : null;
  const asking = shown === null ? null : shown.name;
  const openedAt = shown === null ? null : shown.openedAt;
  const orgName = org?.name ?? "this organization";
  const options: SelectOption[] =
    org === null
      ? []
      : [
          { value: org.slug, label: org.name },
          ...others.map((each) => ({ value: each.slug, label: each.name })),
        ];

  return (
    <div
      className="min-h-dvh px-4 py-10"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <main className="mx-auto w-full max-w-[460px] flex flex-col gap-4">
        <PageHeader page="/link-computer" />

        {finished === "linked" && (
          <Card className="p-4">
            <p className="text-[14px] font-semibold">Linked</p>
            <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
              {asking} is linked to your account in {orgName}. Close this page and go back to
              Schema Studio on the computer.
            </p>
          </Card>
        )}

        {finished === "turned-away" && (
          <Card className="p-4">
            <p className="text-[14px] font-semibold">Nothing was linked</p>
            <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
              That computer was turned away. You can close this page.
            </p>
          </Card>
        )}

        {finished === null && (
          <Card className="p-4 flex flex-col gap-3">
            <p className="text-[13px]" style={{ color: "var(--text-2)" }}>
              Only link a computer you are sitting at. Type the code it is showing in Schema
              Studio&apos;s Settings. Never type a code that someone sent you.
            </p>
            <p className="text-[13px]" style={{ color: "var(--text-2)" }}>
              Linking lets that computer open {orgName}&apos;s saved connections, including their
              passwords, and answer questions from your account.
            </p>

            <div className="flex flex-col gap-1">
              <label className="section-title" htmlFor={codeFieldId}>
                Code shown on the computer
              </label>
              <Input
                id={codeFieldId}
                mono
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setProblem(null);
                }}
              />
            </div>

            {others.length > 0 && org !== null && (
              <div className="flex flex-col gap-1">
                <label className="section-title" htmlFor={orgFieldId}>
                  Organization
                </label>
                <Select
                  id={orgFieldId}
                  ariaLabel="Organization"
                  variant="input"
                  value={org.slug}
                  options={options}
                  onChange={moveTo}
                />
              </div>
            )}

            {asking !== null && (
              <>
                <p className="text-[14px] font-semibold">
                  Link {asking} to {orgName}?
                </p>
                {openedAt !== null && (
                  <p className="text-[13px]" style={{ color: "var(--text-2)" }}>
                    This computer asked to be linked at {clockTime(openedAt)} ({timeAgo(openedAt)}). If you
                    did not start that on your computer just now, choose Not mine.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void answer("POST", COULD_NOT_LINK, "linked")}
                  >
                    Link this computer
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void answer("DELETE", COULD_NOT_TURN_AWAY, "turned-away")}
                  >
                    Not mine
                  </Button>
                </div>
              </>
            )}

            {code === null && typed.trim() !== "" && <Meta>A code has eight letters and numbers.</Meta>}
            {problem !== null && <ErrorNote>{problem}</ErrorNote>}
          </Card>
        )}
      </main>
    </div>
  );
}
