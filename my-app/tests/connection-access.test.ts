// connection-access: who may run a migration against which database.
//
// Spec feature 02 asks for "read-only" and "deployment roles" as two separate
// ideas, and the whole point of this module is that the first one is NOT just
// the bottom of the second. A rank can always be outranked; "read-only" has to
// hold against an admin or it is not a statement about the database at all.
// Most of what is below exists to pin that down, because it is the rule most
// likely to be quietly "simplified" later into one more box on the Roles tab.
//
// The rest guards the two directions the refusal can go wrong: a setting that
// nobody recognises must not lock a connection, and the sentence shown to the
// person who was refused must not send them looking for something that does
// not exist.
import { BUILT_IN_ROLE_INFO, BUILT_IN_ROLES } from "@/lib/permissions";
import {
  DEFAULT_EXECUTE_ROLE,
  EXECUTE_ROLES,
  canExecute,
  describeExecuteRole,
  executeRefusal,
  executeRoleBadge,
  toExecuteRole,
  type ExecuteAbility,
} from "@/lib/connection-access";

// A role is no longer a rank, so the module is asked about abilities: whether
// the person holds "Deploy: Run", and whether they are the Admin role.
const ADMIN: ExecuteAbility = { isAdmin: true, mayDeploy: true };
const DEPLOYER: ExecuteAbility = { isAdmin: false, mayDeploy: true };
const READER: ExecuteAbility = { isAdmin: false, mayDeploy: false };
/** Cannot happen today (admin holds everything), but the rule must not lean on that. */
const ADMIN_WITHOUT_DEPLOY: ExecuteAbility = { isAdmin: true, mayDeploy: false };
const EVERYONE = [ADMIN, DEPLOYER, READER, ADMIN_WITHOUT_DEPLOY];

describe("canExecute", () => {
  test("read-only refuses everyone, admin included", () => {
    // Not "admin is refused" as a one-off: everyone, so that a role made later
    // with every box ticked cannot quietly open a hole in a read-only database.
    for (const who of EVERYONE) {
      expect(canExecute(who, "none")).toBe(false);
    }
  });

  test("a role that may deploy clears a default connection but not an admin one", () => {
    expect(canExecute(DEPLOYER, "editor")).toBe(true);
    expect(canExecute(DEPLOYER, "admin")).toBe(false);
  });

  test("an admin clears both", () => {
    // Upward, not exactly: the requirement is a floor, so being over it is
    // fine. Reading it as an equality would lock admins out of everything
    // except the connections marked for them specifically.
    expect(canExecute(ADMIN, "editor")).toBe(true);
    expect(canExecute(ADMIN, "admin")).toBe(true);
  });

  test("nobody without Deploy: Run clears anything, whatever the connection says", () => {
    // The route gate above this already refuses them, so this is the second of
    // two locks rather than the only one, and it is the one that survives
    // somebody relaxing the gate. The setting narrows who may deploy; it never
    // lets somebody in.
    for (const required of EXECUTE_ROLES) {
      expect(canExecute(READER, required)).toBe(false);
      expect(canExecute(ADMIN_WITHOUT_DEPLOY, required)).toBe(false);
    }
  });
});

describe("toExecuteRole", () => {
  test("keeps every setting the picker can produce", () => {
    for (const required of EXECUTE_ROLES) {
      expect(toExecuteRole(required)).toBe(required);
    }
  });

  test("anything unrecognised falls back to the default, not to read-only", () => {
    // This is the direction that matters. A row written before the column
    // existed, a typo in a hand-edited database, a null — none of those are a
    // decision anybody made to freeze the connection, and treating them as one
    // would stop deployments with no message to act on.
    for (const value of [null, undefined, "", "Admin", "owner", 7, {}]) {
      expect(toExecuteRole(value)).toBe(DEFAULT_EXECUTE_ROLE);
    }
  });

  test("the default is a setting somebody can actually execute under", () => {
    // Guards the pair of constants against drifting apart: if the default were
    // ever changed to "none", every unrecognised value above would become a
    // frozen connection and the fallback test would still pass.
    expect(canExecute(DEPLOYER, DEFAULT_EXECUTE_ROLE)).toBe(true);
  });
});

describe("executeRoleBadge", () => {
  test("the default setting gets no badge", () => {
    // Every connection has a setting; badging all of them puts the same words
    // on every row until nobody reads any of them.
    expect(executeRoleBadge(DEFAULT_EXECUTE_ROLE)).toBeNull();
  });

  test("the settings that change what happens do get one", () => {
    expect(executeRoleBadge("none")).toBe("Read-only");
    expect(executeRoleBadge("admin")).toBe("Admins only");
  });

  test("every setting has a description, badge or not", () => {
    for (const required of EXECUTE_ROLES) {
      expect(describeExecuteRole(required).length).toBeGreaterThan(0);
    }
  });
});

describe("executeRefusal", () => {
  test("names the connection, so the reader can tell which one refused", () => {
    // Someone with four saved connections open in four tabs needs to know it
    // was this one. "403" does not tell them that and neither does "denied".
    expect(executeRefusal("Prod EU", "Editor", "admin")).toContain("Prod EU");
    expect(executeRefusal("Prod EU", "Editor", "none")).toContain("Prod EU");
    expect(executeRefusal("Prod EU", "Viewer", "editor")).toContain("Prod EU");
  });

  test("an admins-only refusal says so, and names the role they have", () => {
    // By its name as people read it, which for a role an admin made is the
    // only name it has.
    const message = executeRefusal("Prod EU", "QA Lead", "admin");
    expect(message).toContain("limited to admins");
    expect(message).toContain('"QA Lead"');
  });

  test("a role that may not deploy is told which box to ask for", () => {
    const message = executeRefusal("Prod EU", "Viewer", "editor");
    expect(message).toContain('"Viewer"');
    expect(message).toContain('"Deploy: Run"');
  });

  test("the read-only sentence never offers a role or a box to go and ask for", () => {
    // The failure this guards is a helpful-sounding message on the wrong rule:
    // if read-only borrowed the role wording, it would tell the reader to ask
    // an admin for something that could not have helped them. Read-only is not
    // about the role, so the sentence points at the setting instead.
    const message = executeRefusal("Reference schema", "Admin", "none");
    expect(message).toContain("read-only");
    for (const role of BUILT_IN_ROLES) {
      expect(message).not.toContain(`"${role}"`);
      expect(message).not.toContain(`"${BUILT_IN_ROLE_INFO[role].label}"`);
    }
    expect(message).not.toMatch(/ask an admin/i);
    expect(message).not.toContain("Deploy: Run");
    expect(message).toMatch(/setting/i);
  });

  test("says what still works, because most of the app still does", () => {
    // A read-only connection is a normal, useful connection — it compares and
    // generates scripts like any other. Without this the refusal reads as the
    // connection being broken.
    const message = executeRefusal("Reference schema", "Admin", "none");
    expect(message).toMatch(/compar/i);
  });
});
