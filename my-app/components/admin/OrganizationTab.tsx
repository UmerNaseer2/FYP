"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { Button, Card, ConfirmDialog, Input, Label, Modal, Skeleton } from "@/components/ui";
import { AlertCircleIcon, AlertTriangleIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import { ORG_NAME_MAX_LENGTH } from "@/lib/new-organization";

/**
 * The Organization tab on the Admin screen: the organization's name, its
 * two-person rule, and deleting it. Only the admin role has the Organization
 * boxes (lib/permissions.ts), and app/api/admin/organization/route.ts checks
 * them again on every request.
 *
 * Renaming keeps the address. Links people saved still work, and the address
 * is shown so nobody expects it to follow the name.
 *
 * The two-person rule is on for every new organization. While it is on, a
 * production deploy waits for someone other than the person who asked for it.
 * Switching it off lets people approve their own, which is the one change here
 * that lowers a safeguard, so it asks first. Both directions go in the change
 * log on the Roles & permissions tab.
 *
 * After a save the page is refreshed from the server, so the rest of the
 * screen (the name in the rail, the deploy pages' wording) catches up.
 *
 * Deleting asks for the name to be typed, because it takes every connection,
 * script, approval and member with it and can't be undone. The route says
 * whether it may be deleted at all (`canDelete`), so no button is drawn that
 * could only be refused.
 */

// Mirrors GET /api/admin/organization.
type Organization = {
  name: string;
  slug: string;
  twoPersonRule: boolean;
  canDelete: boolean;
};

function isOrganization(value: unknown): value is Organization {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.slug === "string" &&
    typeof o.twoPersonRule === "boolean" &&
    typeof o.canDelete === "boolean"
  );
}

export function OrganizationTab({ active }: { active: boolean }) {
  const router = useRouter();
  const { can } = useUser();
  const nameId = useId();
  const confirmId = useId();

  const [org, setOrg] = useState<Organization | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The name field, which starts as the saved name once that has loaded.
  const [name, setName] = useState("");
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<"name" | "rule" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRuleOff, setConfirmRuleOff] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const canUpdate = can("organization:update");

  // Loaded each time the tab is opened, so a rename made elsewhere shows.
  // Not while hidden: nobody is looking at it then.
  useEffect(() => {
    if (!active) return;
    let current = true;
    void (async () => {
      try {
        const response = await apiFetch("/api/admin/organization", { cache: "no-store" });
        const body = await jsonOf(response);
        if (!current) return;
        if (!response.ok || !isOrganization(body)) {
          setLoadError(errorFrom(body) ?? "Could not load the organization.");
          return;
        }
        setOrg(body);
        setName(body.name);
        setLoadError(null);
      } catch {
        if (current) setLoadError("Network error while loading the organization.");
      }
    })();
    return () => {
      current = false;
    };
  }, [active]);

  /** Saves one change, and shows the route's reason when it is refused. */
  async function save(
    what: "name" | "rule",
    changes: { name?: string; twoPersonRule?: boolean }
  ): Promise<void> {
    setSaving(what);
    setActionError(null);
    setNameProblem(null);
    try {
      const response = await apiFetch("/api/admin/organization", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const body = await jsonOf(response);
      if (!response.ok) {
        const reason = errorFrom(body) ?? "Could not save the change.";
        const field = (body as { field?: unknown } | null)?.field;
        if (field === "name") setNameProblem(reason);
        else setActionError(reason);
        return;
      }
      const saved = body as Pick<Organization, "name" | "slug" | "twoPersonRule">;
      setOrg((old) => (old ? { ...old, ...saved } : old));
      setName(saved.name);
      router.refresh();
    } catch {
      setActionError("Network error while saving. Nothing was changed.");
    } finally {
      setSaving(null);
    }
  }

  function rename(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    void save("name", { name });
  }

  if (loadError && !org) {
    return (
      <div className="role-note" role="alert">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">{"Couldn't load the organization"}</div>
          <div className="body">{loadError}</div>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton width="100%" height={120} radius={14} />
        <Skeleton width="100%" height={96} radius={14} />
      </div>
    );
  }

  const nameChanged = name.trim() !== org.name;

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="role-note" role="alert">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">{"Couldn't save"}</div>
            <div className="body">{actionError}</div>
          </div>
        </div>
      )}

      <Card className="p-4 sm:p-5">
        <form onSubmit={rename} noValidate>
          <h3 className="section-title">Name</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div>
              <Label htmlFor={nameId} className="mb-1 block">
                Organization name
              </Label>
              <Input
                id={nameId}
                value={name}
                maxLength={ORG_NAME_MAX_LENGTH}
                readOnly={!canUpdate || saving !== null}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={nameProblem ? true : undefined}
                aria-describedby={nameProblem ? `${nameId}-problem` : `${nameId}-help`}
              />
            </div>
            {canUpdate && (
              <Button type="submit" size="sm" disabled={!nameChanged || saving !== null}>
                {saving === "name" ? "Saving..." : "Save name"}
              </Button>
            )}
          </div>
          {nameProblem ? (
            <p id={`${nameId}-problem`} className="field-problem mt-1.5">
              {nameProblem}
            </p>
          ) : (
            <p id={`${nameId}-help`} className="text-[12.5px] mt-1.5" style={{ color: "var(--text-3)" }}>
              {`The address stays /${org.slug} when the name changes, so saved links keep working.`}
            </p>
          )}
        </form>
      </Card>

      <Card className="p-4 sm:p-5">
        <h3 className="section-title">Two-person rule</h3>
        <label className="mt-2 flex items-start gap-3 text-[13.5px]">
          <input
            type="checkbox"
            role="switch"
            className="mt-0.5"
            checked={org.twoPersonRule}
            disabled={!canUpdate || saving !== null}
            onChange={(event) => {
              if (event.target.checked) void save("rule", { twoPersonRule: true });
              else setConfirmRuleOff(true);
            }}
          />
          <span>
            <span className="font-medium">Production deploys wait for a second person</span>
            <span className="block mt-0.5" style={{ color: "var(--text-2)" }}>
              {org.twoPersonRule
                ? "On. Someone other than the person who asked has to approve each production deploy."
                : "Off. People can approve their own production deploys, and each one is recorded as a self-approval."}
            </span>
          </span>
        </label>
      </Card>

      {org.canDelete && can("organization:delete") && (
        <Card className="p-4 sm:p-5">
          <h3 className="section-title">Delete this organization</h3>
          <p className="text-[13px] mt-2 max-w-[60ch]" style={{ color: "var(--text-2)" }}>
            {`Deletes ${org.name} with its connections, scripts, approvals, invitations and change log, and takes everyone out of it. Their accounts stay, and so do scripts already in the GitHub registry. This can't be undone.`}
          </p>
          <Button variant="destructive" size="sm" className="mt-3" onClick={() => setDeleteOpen(true)}>
            Delete organization
          </Button>
        </Card>
      )}

      <ConfirmDialog
        open={confirmRuleOff}
        onClose={() => setConfirmRuleOff(false)}
        onConfirm={() => void save("rule", { twoPersonRule: false })}
        title="Switch the two-person rule off?"
        description="People will be able to approve their own production deploys. Each one is still recorded, as a self-approval, and the switch goes in the change log."
        confirmLabel="Switch off"
        destructive
      />

      {/* Its own component, so the typed name starts empty on every opening:
          Modal renders nothing while closed. */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} label="Delete this organization">
        <DeleteBody
          org={org}
          inputId={confirmId}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => router.replace("/studio")}
        />
      </Modal>
    </div>
  );
}

function DeleteBody({
  org,
  inputId,
  onClose,
  onDeleted,
}: {
  org: Organization;
  inputId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (busy || typed !== org.name) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await apiFetch("/api/admin/organization", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (response.ok) {
        // /studio sends the person to another organization of theirs, or to
        // onboarding when this was their only one.
        onDeleted();
        return;
      }
      setProblem(errorFrom(await jsonOf(response)) ?? "Could not delete the organization.");
    } catch {
      setProblem("Network error while deleting. Nothing was deleted.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(event) => void remove(event)} noValidate>
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-full grid place-items-center flex-none"
          style={{ background: "var(--break-soft)", color: "var(--break)" }}
        >
          <AlertTriangleIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-[15px] font-semibold">{`Delete ${org.name}?`}</h4>
          <p className="text-[13px] mt-1" style={{ color: "var(--text-2)" }}>
            Everything in it goes, for everyone in it. Type its name to confirm.
          </p>
          <Label htmlFor={inputId} className="mt-3 mb-1 block">
            Organization name
          </Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            readOnly={busy}
            onChange={(event) => setTyped(event.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${inputId}-problem` : undefined}
          />
          {problem && (
            <p id={`${inputId}-problem`} className="field-problem mt-1.5" role="alert">
              {problem}
            </p>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" size="sm" disabled={busy || typed !== org.name}>
          {busy ? "Deleting..." : "Delete organization"}
        </Button>
      </div>
    </form>
  );
}
