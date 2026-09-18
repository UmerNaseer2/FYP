// connection-access: who may run a migration against which database.
//
// Spec feature 02 asks for "read-only" and "deployment roles" as two separate
// ideas, and the whole point of this module is that the first one is NOT just
// the bottom of the second. A rank can always be outranked; "read-only" has to
// hold against an admin or it is not a statement about the database at all.
// Most of what is below exists to pin that down, because it is the rule most
// likely to be quietly "simplified" later into a fourth entry in ROLES.
//
// The rest guards the two directions the refusal can go wrong: a setting that
// nobody recognises must not lock a connection, and the sentence shown to the
// person who was refused must not send them looking for something that does
// not exist.
import { ROLES } from "@/lib/auth-mode";
import {
  DEFAULT_EXECUTE_ROLE,
  EXECUTE_ROLES,
  canExecute,
  describeExecuteRole,
  executeRefusal,
  executeRoleBadge,
  toExecuteRole,
} from "@/lib/connection-access";

describe("canExecute", () => {
  test("read-only refuses every role there is, admin included", () => {
    // Not "admin is refused" as a one-off — every role, so that adding one
    // above admin later cannot quietly open a hole in a read-only database.
    for (const role of ROLES) {
      expect(canExecute(role, "none")).toBe(false);
    }
  });

  test("an editor clears an editor connection but not an admin one", () => {
    expect(canExecute("editor", "editor")).toBe(true);
    expect(canExecute("editor", "admin")).toBe(false);
  });

  test("an admin clears an editor connection", () => {
    // Upward, not exactly: the requirement is a floor, so being over it is
    // fine. Reading it as an equality would lock admins out of everything
    // except the connections marked for them specifically.
    expect(canExecute("admin", "editor")).toBe(true);
    expect(canExecute("admin", "admin")).toBe(true);
  });

  test("a viewer clears nothing, whatever the connection says", () => {
    // The route gate above this already refuses a viewer, so this is the
    // second of two locks rather than the only one — but it is the one that
    // survives somebody relaxing the gate.
    for (const required of EXECUTE_ROLES) {
      expect(canExecute("viewer", required)).toBe(false);
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
    expect(canExecute("editor", DEFAULT_EXECUTE_ROLE)).toBe(true);
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
    expect(executeRefusal("Prod EU", "editor", "admin")).toContain("Prod EU");
    expect(executeRefusal("Prod EU", "editor", "none")).toContain("Prod EU");
  });

  test("a rank refusal says which rank, and which one they have", () => {
    const message = executeRefusal("Prod EU", "editor", "admin");
    expect(message).toContain("admin");
    expect(message).toContain("editor");
  });

  test("the read-only sentence never offers a role to go and ask for", () => {
    // The failure this guards is a helpful-sounding message on the wrong rule:
    // if read-only borrowed the rank wording, it would tell the reader to ask
    // an admin for a promotion that could not have helped them. Read-only is
    // not a rank, so the sentence points at the setting instead.
    const message = executeRefusal("Reference schema", "admin", "none");
    expect(message).toContain("read-only");
    for (const role of ROLES) {
      expect(message).not.toContain(`"${role}"`);
    }
    expect(message).not.toMatch(/ask an admin/i);
    expect(message).toMatch(/setting/i);
  });

  test("says what still works, because most of the app still does", () => {
    // A read-only connection is a normal, useful connection — it compares and
    // generates scripts like any other. Without this the refusal reads as the
    // connection being broken.
    const message = executeRefusal("Reference schema", "admin", "none");
    expect(message).toMatch(/compar/i);
  });
});
