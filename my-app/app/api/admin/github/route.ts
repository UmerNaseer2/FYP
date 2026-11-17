import { NextRequest, NextResponse } from "next/server";
import { requirePermission, type Principal } from "@/lib/auth/guard";
import { actorFor } from "@/lib/auth/mode";
import { checkRepositoryAccess } from "@/lib/github/check";
import { githubConfig } from "@/lib/github/registry";
import {
  REPOSITORY_PROBLEM,
  parseRepository,
  repositoryLabel,
  tokenProblem,
  type GitHubSettingsView,
} from "@/lib/github/settings";
import { readOrgGitHub, removeOrgGitHub, saveOrgGitHub, type GitHubActor } from "@/lib/github/org-store";
import { hasPermission } from "@/lib/roles/permissions";
import { registryRoot } from "@/lib/github/registry-paths";
import { encryptionKeySource } from "@/lib/connections/secret-store";

/**
 * The caller's organization's GitHub settings, from the GitHub tab on the
 * Admin screen: the repository its scripts are kept in, and the access token
 * the app uses for it (lib/github/org-store.ts).
 *
 * GET (github:read) says which repository is used, where it came from and
 * who saved it last. It never sends the token, to anyone: only whether one
 * is saved and readable.
 *
 * PUT (github:update) connects `{ repository, token }`, both required. The
 * repository may be typed as owner/name or pasted as its GitHub address.
 * GitHub is asked first whether the token opens the repository, and nothing
 * is saved when it does not.
 *
 * Once saved, the repository and token are locked together: PUT refuses
 * (409) while a pair is saved, so nobody can point the saved token at
 * another repository or swap the token under the saved repository. To use
 * another repository, DELETE the pair and PUT a new one with its own token.
 *
 * DELETE (github:update) removes the pair, repository and token together.
 * The scripts already in the repository stay there.
 *
 * Every change goes in the change log on the Roles & permissions tab.
 */

const NO_KEY =
  "This server has no encryption key, so it can't keep an access token safe and won't save one. " +
  "Whoever runs the server can set APP_ENCRYPTION_KEY and restart it.";

const NEED_TOKEN = "Paste an access token for the repository. The repository and its token are saved together.";

const LOCKED =
  "GitHub is already connected for this organization. A saved repository and its token stay " +
  "together and can't be changed. Remove them first, then connect a repository with its token.";

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

  if (encryptionKeySource() === "none") return NextResponse.json({ error: NO_KEY }, { status: 503 });

  const fields = await readBody(request);
  if (fields === null) {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const repository = parseRepository(typeof fields.repository === "string" ? fields.repository : "");
  if (!repository) {
    return NextResponse.json({ error: REPOSITORY_PROBLEM, field: "repository" }, { status: 400 });
  }

  // The repository and token come together: a token is never saved, or
  // reused, apart from the repository it was checked against.
  if (fields.token !== undefined && fields.token !== null && typeof fields.token !== "string") {
    return NextResponse.json({ error: "Paste the access token as text.", field: "token" }, { status: 400 });
  }
  const token = typeof fields.token === "string" ? fields.token.trim() : "";
  if (token === "") return NextResponse.json({ error: NEED_TOKEN, field: "token" }, { status: 400 });
  const problem = tokenProblem(token);
  if (problem) return NextResponse.json({ error: problem, field: "token" }, { status: 400 });

  // A saved pair is locked. Refused before GitHub is asked anything, so the
  // typed token is never tried against a locked organization's repository.
  let saved;
  try {
    saved = await readOrgGitHub(principal.orgId);
  } catch (error) {
    console.error("Failed to read the GitHub settings:", error);
    return unavailable("Could not read the saved GitHub settings.");
  }
  if (saved) return locked();

  const check = await checkRepositoryAccess({ ...repository, token });
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: check.status });

  try {
    const added = await saveOrgGitHub(principal.orgId, { ...repository, token }, actorOf(principal));
    switch (added.kind) {
      case "not-found":
        return gone();
      case "no-key":
        return NextResponse.json({ error: NO_KEY }, { status: 503 });
      case "exists":
        // Someone else connected a repository between the read above and the save.
        return locked();
      case "ok":
        return NextResponse.json({
          saved: true,
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

/** A repository and token are already saved, and a saved pair is never changed. */
function locked(): NextResponse {
  return NextResponse.json({ error: LOCKED, locked: true }, { status: 409 });
}

/** A 503 for a database that did not answer, with the reason kept to the log. */
function unavailable(what: string): NextResponse {
  return NextResponse.json(
    { error: `${what} The app's database may be unreachable. Try again in a moment.` },
    { status: 503 }
  );
}
