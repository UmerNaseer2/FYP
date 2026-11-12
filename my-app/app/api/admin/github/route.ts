import { NextRequest, NextResponse } from "next/server";
import { requirePermission, type Principal } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { checkRepositoryAccess } from "@/lib/github-check";
import { githubConfig } from "@/lib/github-registry";
import {
  REPOSITORY_PROBLEM,
  parseRepository,
  repositoryLabel,
  tokenProblem,
  type GitHubSettingsView,
} from "@/lib/github-settings";
import { readOrgGitHub, removeOrgGitHub, saveOrgGitHub, type GitHubActor } from "@/lib/org-github-store";
import { hasPermission } from "@/lib/permissions";
import { registryRoot } from "@/lib/registry-paths";
import { encryptionKeySource } from "@/lib/secret-store";

/**
 * The caller's organization's GitHub settings, from the GitHub tab on the
 * Admin screen: the repository its scripts are kept in, and the access token
 * the app uses for it (lib/org-github-store.ts).
 *
 * GET (github:read) says which repository is used, where it came from and
 * who saved it last. It never sends the token, to anyone: only whether one
 * is saved and readable.
 *
 * PUT (github:update) saves `{ repository, token? }`. The repository may be
 * typed as owner/name or pasted as its GitHub address. Leave the token out
 * to keep the one already saved. GitHub is asked first whether the token
 * opens the repository, and nothing is saved when it does not.
 *
 * DELETE (github:update) forgets the settings, token and all. The scripts
 * already in the repository stay there.
 *
 * Every change goes in the change log on the Roles & permissions tab.
 *
 * The desktop app keeps its own settings in its Settings window and the
 * system keyring, so it saves nothing here.
 */

const DESKTOP =
  "The desktop app keeps its GitHub settings in its own Settings window. Open Settings from the File menu.";

const NO_KEY =
  "This server has no encryption key, so it can't keep an access token safe and won't save one. " +
  "Whoever runs the server can set APP_ENCRYPTION_KEY and restart it.";

const NEED_TOKEN = "Paste an access token for the repository. None is saved for this organization yet.";

const UNREADABLE_SAVED =
  "The saved access token can't be read on this server any more: the server's encryption key has " +
  "changed since it was saved. Paste the token again.";

export async function GET() {
  const gate = await requirePermission("github:read");
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json(await viewFor(gate.principal));
  } catch (error) {
    console.error("Failed to read the GitHub settings:", error);
    return unavailable("Could not read the GitHub settings.");
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requirePermission("github:update");
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  if (onDesktop()) return NextResponse.json({ error: DESKTOP }, { status: 403 });
  if (encryptionKeySource() === "none") return NextResponse.json({ error: NO_KEY }, { status: 503 });

  const fields = await readBody(request);
  if (fields === null) {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const repository = parseRepository(typeof fields.repository === "string" ? fields.repository : "");
  if (!repository) {
    return NextResponse.json({ error: REPOSITORY_PROBLEM, field: "repository" }, { status: 400 });
  }

  // A token left out, or left blank, keeps the one already saved.
  if (fields.token !== undefined && fields.token !== null && typeof fields.token !== "string") {
    return NextResponse.json({ error: "Paste the access token as text.", field: "token" }, { status: 400 });
  }
  const typed = typeof fields.token === "string" ? fields.token.trim() : "";
  let token: string | null = null;
  if (typed !== "") {
    const problem = tokenProblem(typed);
    if (problem) return NextResponse.json({ error: problem, field: "token" }, { status: 400 });
    token = typed;
  }

  // GitHub checks the token that will be used: the new one, or the saved one.
  let checkWith = token;
  if (checkWith === null) {
    let saved;
    try {
      saved = await readOrgGitHub(principal.orgId);
    } catch (error) {
      console.error("Failed to read the GitHub settings:", error);
      return unavailable("Could not read the saved GitHub settings.");
    }
    if (!saved) return NextResponse.json({ error: NEED_TOKEN, field: "token" }, { status: 400 });
    if (saved.token === null) return NextResponse.json({ error: UNREADABLE_SAVED, field: "token" }, { status: 400 });
    checkWith = saved.token;
  }

  const check = await checkRepositoryAccess({ ...repository, token: checkWith });
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: check.status });

  try {
    const saved = await saveOrgGitHub(principal.orgId, { ...repository, token }, actorOf(principal));
    switch (saved.kind) {
      case "not-found":
        return gone();
      case "no-key":
        return NextResponse.json({ error: NO_KEY }, { status: 503 });
      case "no-token":
        // The saved token went between the read above and the save.
        return NextResponse.json({ error: NEED_TOKEN, field: "token" }, { status: 400 });
      case "ok":
        return NextResponse.json({
          saved: true,
          changed: saved.changed || check.created,
          created: check.created,
          repository: repositoryLabel(repository),
        });
    }
  } catch (error) {
    console.error("Failed to save the GitHub settings:", error);
    return unavailable("Could not save the GitHub settings.");
  }
}

export async function DELETE() {
  const gate = await requirePermission("github:update");
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  if (onDesktop()) return NextResponse.json({ error: DESKTOP }, { status: 403 });

  try {
    const { removed } = await removeOrgGitHub(principal.orgId, actorOf(principal));
    return NextResponse.json({ removed });
  } catch (error) {
    console.error("Failed to remove the GitHub settings:", error);
    return unavailable("Could not remove the GitHub settings.");
  }
}

/** What the GitHub tab shows. Never the token. Throws when the database does not answer. */
async function viewFor(principal: Principal): Promise<GitHubSettingsView> {
  const folder = registryRoot(principal);
  const serverReady = githubConfig().ok;

  if (onDesktop()) {
    return {
      source: serverReady ? "server" : "none",
      repository: null,
      folder,
      tokenUnreadable: false,
      updatedBy: null,
      updatedAt: null,
      serverFallback: true,
      cannotSave: DESKTOP,
      canUpdate: false,
    };
  }

  const saved = await readOrgGitHub(principal.orgId);
  const shared = {
    folder,
    serverFallback: principal.orgIsDefault,
    cannotSave: encryptionKeySource() === "none" ? NO_KEY : null,
    canUpdate: hasPermission(principal, "github:update"),
  };
  if (saved) {
    return {
      ...shared,
      source: "organization",
      repository: repositoryLabel(saved),
      tokenUnreadable: saved.token === null,
      updatedBy: saved.updatedBy,
      updatedAt: new Date(saved.updatedAt).toISOString(),
    };
  }
  return {
    ...shared,
    // Only the default organization falls back to the server's own settings.
    source: principal.orgIsDefault && serverReady ? "server" : "none",
    repository: null,
    tokenUnreadable: false,
    updatedBy: null,
    updatedAt: null,
  };
}

/** Who the change log names, and the role that let them make the change. */
function actorOf(principal: Principal): GitHubActor {
  return { email: actorFor(principal), role: principal.role };
}

/** The body's fields, or null when it is not a JSON object. */
async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The organization was deleted between the gate and the write. */
function gone(): NextResponse {
  return NextResponse.json(
    { error: "This organization no longer exists. Someone may have just deleted it." },
    { status: 404 }
  );
}

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/** A 503 for a database that did not answer, with the reason kept to the log. */
function unavailable(what: string): NextResponse {
  return NextResponse.json(
    { error: `${what} The app's database may be unreachable. Try again in a moment.` },
    { status: 503 }
  );
}
