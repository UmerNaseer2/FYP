"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { AskAdmin } from "@/components/studio/AskAdmin";
import { useUser } from "@/hooks/useUser";
import { Button, Card, ConfirmDialog, Input, Label, Skeleton } from "@/components/ui";
import { AlertCircleIcon, AlertTriangleIcon, CheckIcon, InfoIcon } from "@/components/ui/icons";
import { apiFetch } from "@/lib/api-fetch";
import { errorFrom, jsonOf } from "@/lib/api-answer";
import type { GitHubSettingsView } from "@/lib/github-settings";
import { refusalMessage } from "@/lib/permissions";
import { timeAgo } from "@/lib/time-ago";

/**
 * The GitHub tab on the Admin screen: the repository this organization keeps
 * its scripts in, and the access token the app uses for it. Out of the box
 * only the admin role has the GitHub registry permissions (lib/permissions.ts),
 * and app/api/admin/github/route.ts checks them again on every request.
 *
 * The token never comes back to the browser, not even for an Admin: the route
 * only says whether one is saved and still readable. So the token box always
 * starts empty, and leaving it empty keeps the saved token.
 *
 * GitHub is asked before anything is saved, so a token that can't open the
 * repository is turned down with the reason, under the box to fix.
 *
 * Every save and removal goes in the change log on the Roles & permissions tab.
 */

function isView(value: unknown): value is GitHubSettingsView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const textOrNull = (field: unknown) => typeof field === "string" || field === null;
  return (
    (v.source === "organization" || v.source === "server" || v.source === "none") &&
    textOrNull(v.repository) &&
    typeof v.folder === "string" &&
    typeof v.tokenUnreadable === "boolean" &&
    textOrNull(v.updatedBy) &&
    textOrNull(v.updatedAt) &&
    typeof v.serverFallback === "boolean" &&
    textOrNull(v.cannotSave) &&
    typeof v.canUpdate === "boolean"
  );
}

type Problem = { field: "repository" | "token"; message: string };

export function GitHubTab({ active }: { active: boolean }) {
  const { roleLabel } = useUser();
  const repositoryId = useId();
  const tokenId = useId();

  const [view, setView] = useState<GitHubSettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped after a save or a removal, to load the settings again.
  const [loads, setLoads] = useState(0);
  // The repository box starts as the saved repository once that has loaded.
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState<"save" | "remove" | null>(null);
  // What went wrong with the last save or removal, and which of the two it was.
  const [actionError, setActionError] = useState<{ what: "save" | "remove"; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Loaded each time the tab is opened, so a change made elsewhere shows.
  // Not while hidden: nobody is looking at it then.
  useEffect(() => {
    if (!active) return;
    let current = true;
    void (async () => {
      try {
        const response = await apiFetch("/api/admin/github", { cache: "no-store" });
        const body = await jsonOf(response);
        if (!current) return;
        if (!response.ok || !isView(body)) {
          setLoadError(errorFrom(body) ?? "Could not load the GitHub settings.");
          return;
        }
        setView(body);
        setRepository(body.repository ?? "");
        setLoadError(null);
      } catch {
        if (current) setLoadError("Network error while loading the GitHub settings.");
      }
    })();
    return () => {
      current = false;
    };
  }, [active, loads]);

  /** Clears what an earlier save said, before the next one. */
  function startAction(what: "save" | "remove") {
    setSaving(what);
    setActionError(null);
    setProblem(null);
    setNotice(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    startAction("save");
    const typedToken = token.trim();
    try {
      const response = await apiFetch("/api/admin/github", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // No token keeps the saved one.
        body: JSON.stringify(typedToken === "" ? { repository } : { repository, token: typedToken }),
      });
      const body = await jsonOf(response);
      if (!response.ok) {
        const reason = errorFrom(body) ?? "Could not save the GitHub settings.";
        const field = (body as { field?: unknown } | null)?.field;
        if (field === "repository" || field === "token") setProblem({ field, message: reason });
        else setActionError({ what: "save", message: reason });
        return;
      }
      const saved = body as { changed?: unknown; repository?: unknown };
      const label = typeof saved.repository === "string" ? saved.repository : repository.trim();
      setNotice(
        saved.changed === false
          ? `Nothing changed. GitHub still accepts the saved token for ${label}.`
          : `Saved. GitHub accepted the token for ${label}.`
      );
      setToken("");
      setLoads((n) => n + 1);
    } catch {
      setActionError({ what: "save", message: "Network error while saving. Nothing was changed." });
    } finally {
      setSaving(null);
    }
  }

  async function remove() {
    if (saving) return;
    startAction("remove");
    try {
      const response = await apiFetch("/api/admin/github", { method: "DELETE" });
      if (!response.ok) {
        setActionError({
          what: "remove",
          message: errorFrom(await jsonOf(response)) ?? "Could not remove the GitHub settings.",
        });
        return;
      }
      setNotice("Removed. The scripts already in the repository are still there.");
      setToken("");
      setLoads((n) => n + 1);
    } catch {
      setActionError({ what: "remove", message: "Network error while removing. Nothing was changed." });
    } finally {
      setSaving(null);
    }
  }

  if (loadError && !view) {
    return (
      <div className="role-note" role="alert">
        <AlertCircleIcon size={15} className="ico" />
        <div>
          <div className="title">{"Couldn't load the GitHub settings"}</div>
          <div className="body">{loadError}</div>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton width="100%" height={96} radius={14} />
        <Skeleton width="100%" height={160} radius={14} />
      </div>
    );
  }

  const editable = view.canUpdate && view.cannotSave === null;
  const ownSettings = view.source === "organization";
  // An empty token box keeps the saved token, when there is one to keep.
  const keepsToken = ownSettings && !view.tokenUnreadable;
  const repositoryProblem = problem?.field === "repository" ? problem.message : null;
  const tokenProblem = problem?.field === "token" ? problem.message : null;

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="role-note" role="alert">
          <AlertCircleIcon size={15} className="ico" />
          <div>
            <div className="title">{actionError.what === "remove" ? "Couldn't remove" : "Couldn't save"}</div>
            <div className="body">{actionError.message}</div>
          </div>
        </div>
      )}
      {notice && (
        <div className="role-note" role="status">
          <CheckIcon size={15} className="ico" />
          <div className="body">{notice}</div>
        </div>
      )}

      <Card className="p-4 sm:p-5">
        <h3 className="section-title">Where scripts are kept</h3>
        <div className="mt-2 text-[13.5px]">
          {ownSettings ? (
            <>
              <p>
                {"Scripts are kept in the GitHub repository "}
                <span className="mono font-medium">{view.repository}</span>
                {view.folder ? `, in its ${view.folder} folder.` : "."}
              </p>
              {view.updatedBy && view.updatedAt && (
                <p className="text-[12.5px] mt-1" style={{ color: "var(--text-3)" }}>
                  {`Saved by ${view.updatedBy}, ${timeAgo(view.updatedAt)}.`}
                </p>
              )}
            </>
          ) : view.source === "server" ? (
            <p>
              This organization uses the GitHub settings the app was set up with. They are not shown here.
              {editable && " Saving a repository and token below replaces them for this organization."}
            </p>
          ) : (
            <p>{"Not connected. Scripts can't be pushed to GitHub or pulled from it yet."}</p>
          )}
        </div>

        {view.tokenUnreadable && (
          <div className="warn-inline mt-3">
            <AlertTriangleIcon size={15} className="ico" />
            <div>
              <div className="title">{"The saved token can't be read"}</div>
              <div className="body">
                {"The server's encryption key has changed since the token was saved, so the app can't use it. " +
                  "Paste the token again, or a new one, and save."}
              </div>
            </div>
          </div>
        )}

        {view.cannotSave !== null ? (
          <div className="role-note mt-3">
            <InfoIcon size={15} className="ico" />
            <div>
              <div className="title">{"These settings can't be changed here"}</div>
              <div className="body">{view.cannotSave}</div>
            </div>
          </div>
        ) : (
          !view.canUpdate && (
            <div className="role-note mt-3">
              <InfoIcon size={15} className="ico" />
              <div>
                <div className="title">You can see these settings but not change them</div>
                <div className="body">
                  {refusalMessage(roleLabel, "github:update")}
                  <AskAdmin permission="github:update" />
                </div>
              </div>
            </div>
          )
        )}
      </Card>

      {editable && (
        <Card className="p-4 sm:p-5">
          <form onSubmit={(event) => void save(event)} noValidate>
            <h3 className="section-title">{ownSettings ? "Change the repository or token" : "Connect a repository"}</h3>
            <div className="mt-2 space-y-3">
              <div>
                <Label htmlFor={repositoryId} className="mb-1 block">
                  Repository
                </Label>
                <Input
                  id={repositoryId}
                  mono
                  value={repository}
                  placeholder="acme/schema-scripts"
                  autoComplete="off"
                  spellCheck={false}
                  readOnly={saving !== null}
                  onChange={(event) => {
                    setRepository(event.target.value);
                    if (problem?.field === "repository") setProblem(null);
                  }}
                  aria-invalid={repositoryProblem ? true : undefined}
                  aria-describedby={repositoryProblem ? `${repositoryId}-problem` : `${repositoryId}-help`}
                />
                {repositoryProblem ? (
                  <p id={`${repositoryId}-problem`} className="field-problem mt-1.5">
                    {repositoryProblem}
                  </p>
                ) : (
                  <p id={`${repositoryId}-help`} className="text-[12.5px] mt-1.5" style={{ color: "var(--text-3)" }}>
                    Type it as owner/name, or paste its address from GitHub.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor={tokenId} className="mb-1 block">
                  Access token
                </Label>
                <Input
                  id={tokenId}
                  type="password"
                  mono
                  value={token}
                  placeholder={keepsToken ? "Leave blank to keep the saved token" : "github_pat_..."}
                  autoComplete="off"
                  spellCheck={false}
                  readOnly={saving !== null}
                  onChange={(event) => {
                    setToken(event.target.value);
                    if (problem?.field === "token") setProblem(null);
                  }}
                  aria-invalid={tokenProblem ? true : undefined}
                  aria-describedby={tokenProblem ? `${tokenId}-problem` : `${tokenId}-help`}
                />
                {tokenProblem ? (
                  <p id={`${tokenId}-problem`} className="field-problem mt-1.5">
                    {tokenProblem}
                  </p>
                ) : (
                  <p id={`${tokenId}-help`} className="text-[12.5px] mt-1.5" style={{ color: "var(--text-3)" }}>
                    {keepsToken
                      ? "Leave it blank to keep the saved token. A new one is stored encrypted and is never shown again, here or anywhere else."
                      : "It is stored encrypted and is never shown again, here or anywhere else."}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={saving !== null}>
                {saving === "save" ? "Checking with GitHub..." : "Save"}
              </Button>
              {ownSettings && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving !== null}
                  onClick={() => setConfirmRemove(true)}
                >
                  {saving === "remove" ? "Removing..." : "Remove"}
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}

      {editable && (
        <Card className="p-4 sm:p-5">
          <h3 className="section-title">Making an access token</h3>
          <ol className="mt-2 list-decimal pl-5 space-y-1.5 text-[13px]" style={{ color: "var(--text-2)" }}>
            <li>
              On GitHub, open Settings, then Developer settings, then Personal access tokens, then Fine-grained
              tokens, and choose Generate new token.
            </li>
            <li>Under Repository access, choose Only select repositories, and pick the repository above.</li>
            <li>Under Permissions, set Contents to Read and write. The app needs nothing else.</li>
            <li>Generate the token, copy it, and paste it here.</li>
          </ol>
          <p className="text-[12.5px] mt-3" style={{ color: "var(--text-3)" }}>
            {"A token stops working on the date you pick when you make it. When it does, make a new one and paste it here. " +
              "If the repository belongs to a GitHub organization, that organization may have to approve the token first."}
          </p>
        </Card>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
        title="Remove the GitHub settings?"
        description={
          view.serverFallback
            ? "The app forgets this repository and its token, and this organization goes back to the GitHub settings the app was set up with. Scripts already in the repository stay there. The removal goes in the change log."
            : "The app forgets this repository and its token, so scripts can't be pushed or pulled until new ones are saved. Scripts already in the repository stay there. The removal goes in the change log."
        }
        confirmLabel="Remove"
        destructive
      />
    </div>
  );
}
