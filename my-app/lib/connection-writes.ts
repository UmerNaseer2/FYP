import pool, { syncMetadataTables } from "@/lib/version-db";
import type { Principal } from "@/lib/auth-guard";
import { getConnectionDependents } from "@/lib/lineage-db";
import { randomUUID } from "node:crypto";
import { buildPgConfig, checkConnectionTarget } from "@/lib/connection-config";
import { encryptSecret } from "@/lib/secret-store";
import { isPrivateHost } from "@/lib/host-guard";
import {
  localMachineName,
  localSecretFor,
  localStoreConfigured,
  makeLocalMarker,
  parseLocalMarker,
  type LocalEntry,
} from "@/lib/local-secrets";
import { deleteLocalSecret, saveLocalSecret } from "@/lib/local-store";
import { hasPermission } from "@/lib/permissions";
import { toEnvironment } from "@/lib/environments";
import {
  UNLABEL_PRODUCTION_PERMISSION,
  lowersProduction,
  unlabelRefusal,
} from "@/lib/environment-guard";
import {
  REENTER_CONNECTION_STRING_MESSAGE,
  REENTER_PASSWORD_MESSAGE,
  savedPasswordWouldMove,
  tlsWouldWeaken,
  sslModeFromLegacyBoolean,
  sslModeUsesTls,
  summariseErrors,
  toSslMode,
  validateConnection,
  type SslMode,
} from "@/lib/connection-validate";

/**
 * Saving, changing and deleting a saved connection, for whoever the caller's
 * gate says is asking. Two doors lead here: the Connections page
 * (app/api/connections) and a linked desktop acting as its person
 * (app/api/agent/sync/connections). Each door checks its own caller; what
 * happens after that is this file, once, so the two cannot drift apart.
 *
 * The rules are the ones app/api/connections/route.ts describes, plus one:
 * every save moves the row's `version` on, and a change or delete that names
 * the version it started from (`base_version`) is turned down with 409 and the
 * row as it is now when someone else saved in between. A caller that names no
 * version, such as an older page, is not checked, the way it never was.
 */

/**
 * Columns safe to return to the browser, once passed through publicRow.
 *
 * A local connection's password column holds a marker, not a secret (see
 * lib/local-secrets): `lives_on` is the machine named in it and `local_key`
 * finds its password in that machine's own store. publicRow drops the key.
 */
export const PUBLIC_COLUMNS = `id, name, host, port, database_name, type, username,
                (connection_string IS NOT NULL AND connection_string <> '') AS has_connection_string,
                (password IS NOT NULL AND password <> '') AS has_password,
                ssl, ssl_mode, environment, application_table, execute_role,
                last_tested_at, last_test_ok, last_test_version,
                last_test_latency_ms, last_test_error,
                version, updated_at, updated_by, site_id, site_version,
                substring(password from '^local:v1:[^:]*:(.*)$') AS lives_on,
                substring(password from '^local:v1:([^:]*):') AS local_key`;

/**
 * A row read with PUBLIC_COLUMNS, ready for the browser.
 *
 * `local_here` says whether this machine holds a local connection's password,
 * which is what lets the page offer Test and Edit. Whether it has a password or
 * a connection string comes from this machine's store when it does.
 */
export function publicRow(row: Record<string, unknown>): Record<string, unknown> {
  const { local_key: localKey, ...rest } = row;
  if (typeof localKey !== "string" || localKey === "") {
    return { ...rest, lives_on: null, local_here: false };
  }
  const entry = localSecretFor(localKey);
  if (!entry) return { ...rest, local_here: false, has_password: true, has_connection_string: false };
  return {
    ...rest,
    local_here: true,
    has_password: Boolean(entry.password),
    has_connection_string: Boolean(entry.connectionString),
  };
}

/**
 * Whether a saved connection should keep its password on this machine.
 *
 * Only a copy with its own store (LOCAL_DATABASE_URL) has local connections at
 * all. The form says so with `local_only`; a caller that does not say (an
 * older page, a script) gets the guess: an address only this machine or its
 * network can reach is local.
 */
function wantsLocal(body: Record<string, unknown>, guess: () => boolean, current: boolean | null): boolean {
  if (!localStoreConfigured()) return false;
  if (typeof body.local_only === "boolean") return body.local_only;
  return current ?? guess();
}

/** The host a connection would really dial, for the local guess. */
function dialledHost(input: { host: string; port: number; database_name: string; username: string; password: string; connection_string: string }): string | undefined {
  try {
    return buildPgConfig({
      host: input.host,
      port: input.port,
      database: input.database_name,
      user: input.username,
      password: input.password,
      connectionString: input.connection_string,
    }).host;
  } catch {
    return input.host;
  }
}

/** Said when a local connection is changed on a machine that does not hold its password. */
export function editElsewhereMessage(machine: string): string {
  return `This database lives on ${machine}. Open Schema Studio there to change it.`;
}

/**
 * The password and connection string saved for a row, still encrypted.
 *
 * A cloud row's are its own columns. A local row's come from this machine's
 * store; on its own machine with the store emptied they are blank, so the
 * person can type the password again. Anywhere else the answer names the
 * machine that holds them.
 */
export function savedSecrets(
  password: string | null | undefined,
  connectionString: string | null | undefined
): { ok: true; password: string; connectionString: string } | { ok: false; machine: string } {
  const marker = parseLocalMarker(password);
  if (!marker) return { ok: true, password: String(password ?? ""), connectionString: String(connectionString ?? "") };
  const held = localSecretFor(marker.key);
  if (held) return { ok: true, password: held.password ?? "", connectionString: held.connectionString ?? "" };
  if (localStoreConfigured() && marker.machine === localMachineName()) {
    return { ok: true, password: "", connectionString: "" };
  }
  return { ok: false, machine: marker.machine };
}

export type WriteAnswer = { status: number; body: unknown };

function reply(body: unknown, init?: { status: number }): WriteAnswer {
  return { status: init?.status ?? 200, body };
}

/** Who saved, as the "someone changed this" message names them. */
function savedBy(principal: Principal): string {
  return principal.name || principal.email || "Someone";
}

/** The version a save started from, or null when the caller did not say. */
function baseVersion(body: Record<string, unknown>): number | null {
  const value = body.base_version;
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * On a desktop, a copy of a connection the linked website owns. It is changed
 * on the website, through the link, and never here: a change made only here
 * would be overwritten by the next sync without anyone being told.
 */
export const SITE_OWNED_MESSAGE =
  "This connection belongs to the website this computer is linked to. Change it there, or through the link while online.";

async function conflict(principal: Principal, id: number): Promise<WriteAnswer> {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM connections WHERE id = $1 AND org_id = $2`,
    [id, principal.orgId]
  );
  if (rows.length === 0) return reply({ error: "Connection not found." }, { status: 404 });
  const current = rows[0] as { name: string; updated_by: string | null };
  const who = current.updated_by ? `${current.updated_by} saved` : "Someone saved";
  return reply(
    {
      error: `${who} "${current.name}" after you opened it. Keep their version, or save yours on top.`,
      conflict: true,
      current: publicRow(rows[0]),
    },
    { status: 409 }
  );
}

export async function createConnection(
  principal: Principal,
  body: Record<string, unknown>
): Promise<WriteAnswer> {
  // Accept either the new three-way mode or the old boolean, so an older client
  // (or a saved bookmarklet/curl) keeps working.
  const ssl_mode: SslMode =
    body.ssl_mode !== undefined && body.ssl_mode !== null && body.ssl_mode !== ""
      ? toSslMode(body.ssl_mode)
      : sslModeFromLegacyBoolean(body.ssl);

  const checked = validateConnection({ ...body, ssl_mode }, "create");
  if (!checked.ok) {
    return reply(
      { error: summariseErrors(checked.errors), errors: checked.errors },
      { status: 400 }
    );
  }
  const value = checked.value;

  // The SSRF guard used to run only on "Test connection", which meant a blocked
  // host could still be saved and then dialled by Deploy, Drift or Compare.
  //
  // It judges the host the driver would really use, not the one the URL reads
  // as naming: in "postgres://user:pw@db.example.com/app?host=169.254.169.254"
  // the query parameter wins, and this row would have been saved as a database
  // on the internet that dials the cloud metadata service.
  const hostCheck = checkConnectionTarget({
    host: value.host,
    port: value.port,
    database: value.database_name,
    user: value.username,
    password: value.password,
    connectionString: value.connection_string,
    sslMode: value.ssl_mode,
  });
  if (!hostCheck.ok) {
    return reply({ error: hostCheck.message }, { status: 400 });
  }

  // A local connection's password is saved on this machine first, so the
  // shared row never points at a password that is not there.
  const localKey = wantsLocal(body, () => isPrivateHost(dialledHost(value)), null) ? randomUUID() : null;

  try {
    await syncMetadataTables();

    if (localKey) {
      try {
        await saveLocalSecret(localKey, { password: value.password, connectionString: value.connection_string });
      } catch (error) {
        console.error("POST connection: the local password store could not be written:", error);
        return reply(
          { error: `The password could not be saved on ${localMachineName()}. Check its local database (LOCAL_DATABASE_URL).` },
          { status: 500 }
        );
      }
    }

    const result = await pool.query(
      `
      INSERT INTO connections
      (name, host, port, database_name, type, username, password, connection_string,
       ssl, ssl_mode, environment, application_table, execute_role, org_id,
       version, updated_at, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, 1, now(), $15)
      RETURNING ${PUBLIC_COLUMNS}
      `,
      [
        value.name,
        value.host,
        value.port,
        value.database_name,
        value.type,
        value.username,
        localKey ? makeLocalMarker(localKey, localMachineName()) : (encryptSecret(value.password) ?? ""),
        localKey ? null : encryptSecret(value.connection_string) || null,
        sslModeUsesTls(value.ssl_mode),
        value.ssl_mode,
        value.environment,
        value.application_table,
        value.execute_role,
        principal.orgId,
        savedBy(principal),
      ]
    );

    return reply(publicRow(result.rows[0]));
  } catch (error) {
    if (localKey) await deleteLocalSecret(localKey);
    console.error("POST connection error:", error);
    return reply({ error: "Failed to save connection." }, { status: 500 });
  }
}

export async function updateConnection(
  principal: Principal,
  body: Record<string, unknown>
): Promise<WriteAnswer> {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply({ error: "A connection id is required." }, { status: 400 });
  }

  const ssl_mode: SslMode =
    body.ssl_mode !== undefined && body.ssl_mode !== null && body.ssl_mode !== ""
      ? toSslMode(body.ssl_mode)
      : sslModeFromLegacyBoolean(body.ssl);

  // "edit" mode: a blank password means "keep the stored one", so it is not an
  // error here the way it is on create.
  const checked = validateConnection({ ...body, ssl_mode }, "edit");
  if (!checked.ok) {
    return reply(
      { error: summariseErrors(checked.errors), errors: checked.errors },
      { status: 400 }
    );
  }
  const value = checked.value;

  // The host check runs further down, once the stored row has been read: on an
  // edit a blank connection string means "keep the saved one", so the host this
  // connection would dial after the save is not always in this request.

  // …EXCEPT when the editor switched to Fields mode: there the user is
  // redefining the target by loose host/port/user fields, so any stored URI
  // must be cleared — otherwise the old URI would still win over the fields.
  const clearConnectionString = Boolean(body.clear_connection_string);

  // Puts this machine's store back the way it was when the shared row could
  // not be saved after all.
  let undoLocalSave: (() => Promise<void>) | null = null;

  try {
    await syncMetadataTables();

    // Work out what credential the row would have AFTER this update, and refuse
    // to save a connection that would end up with neither a password nor a
    // connection string (otherwise it silently becomes impossible to
    // authenticate). POST guards this on create; PUT has to read the existing
    // row first, because a blank password means "keep the stored one" and
    // `clearConnectionString` wipes any stored URI.
    const existing = await pool.query<{
      password: string | null;
      connection_string: string | null;
      host: string;
      port: number;
      database_name: string;
      username: string;
      ssl: boolean | null;
      ssl_mode: string | null;
      name: string;
      environment: string | null;
      version: number;
      site_id: number | null;
    }>(
      `SELECT password, connection_string, host, port, database_name, username, ssl, ssl_mode,
              name, environment, version, site_id
         FROM connections WHERE id = $1 AND org_id = $2`,
      [id, principal.orgId]
    );
    // Another organization's connection reads as missing, the same answer a
    // deleted one gets, so this cannot be used to learn which ids exist.
    if (existing.rows.length === 0) {
      return reply({ error: "Connection not found." }, { status: 404 });
    }
    if (existing.rows[0].site_id != null) {
      return reply({ error: SITE_OWNED_MESSAGE, siteOwned: true }, { status: 409 });
    }
    // A local connection is changed only on the machine that holds its
    // password: anywhere else there is nothing to check the change against.
    // On its own machine with the password gone (the store was reset), it can
    // be saved again with the password typed in.
    const marker = parseLocalMarker(existing.rows[0].password);
    const held: LocalEntry | null = marker ? localSecretFor(marker.key) : null;
    if (marker && !held && !(localStoreConfigured() && marker.machine === localMachineName())) {
      return reply({ error: editElsewhereMessage(marker.machine), livesOn: marker.machine }, { status: 409 });
    }
    // Checked before anything else about the change, so a person who started
    // from an old copy hears about that first, not about a rule the newer
    // version may have made moot.
    const startedFrom = baseVersion(body);
    if (startedFrom !== null && startedFrom !== Number(existing.rows[0].version)) {
      return conflict(principal, id);
    }

    // Taking the Production label off is what would let a deploy skip its
    // approval, so it needs the permission that gives approvals. See
    // lib/environment-guard.
    const environmentBefore = toEnvironment(existing.rows[0].environment);
    if (lowersProduction(environmentBefore, value.environment)) {
      if (!hasPermission(principal, UNLABEL_PRODUCTION_PERMISSION)) {
        return reply(
          { error: unlabelRefusal(`connection "${existing.rows[0].name}"`) },
          { status: 403 }
        );
      }
      console.info(
        `Connection ${id} ("${existing.rows[0].name}") in organization ${principal.orgId} ` +
          `relabelled from prod to ${value.environment} by ${principal.email}.`
      );
    }

    // These stay encrypted — we only need to know whether they are non-empty.
    // A local connection's are the ones this machine holds.
    const storedPassword = String((marker ? held?.password : existing.rows[0].password) ?? "");
    const storedConnString = String((marker ? held?.connectionString : existing.rows[0].connection_string) ?? "");

    // Mirror the CASE logic in the UPDATE below exactly.
    const effectivePassword = value.password === "" ? storedPassword : value.password;
    const effectiveConnString = clearConnectionString
      ? ""
      : value.connection_string === ""
        ? storedConnString
        : value.connection_string;

    if (!effectivePassword && !effectiveConnString) {
      return reply(
        {
          error:
            "This connection would have no password or connection string. " +
            "Enter a password (or keep a connection string) before saving.",
        },
        { status: 400 }
      );
    }

    // Where this row would dial after the save — the effective values, because
    // a kept connection string decides that and is not in this request. Same
    // guard as POST: the host the driver resolves, not the one the URL reads as
    // naming. The stored string is still encrypted here; checkConnectionTarget
    // decrypts it the way every consumer of a saved credential does.
    const hostCheck = checkConnectionTarget({
      host: value.host,
      port: value.port,
      database: value.database_name,
      user: value.username,
      password: effectivePassword,
      connectionString: effectiveConnString,
      sslMode: value.ssl_mode,
    });
    if (!hostCheck.ok) {
      return reply({ error: hostCheck.message }, { status: 400 });
    }

    // A blank password keeps the saved one, so the saved one must keep going to
    // the same place. Without this, an editor could point the connection at a
    // server they run, leave the password blank, press Test, and receive a
    // password nobody ever showed them. See savedPasswordWouldMove.
    //
    // Only when the loose fields are what the app will dial: a connection
    // string, kept or new, decides the destination itself and carries its own
    // password.
    const keepsSavedPassword = value.password === "" && storedPassword !== "";
    if (keepsSavedPassword && !effectiveConnString) {
      const saved = existing.rows[0];
      const moved = savedPasswordWouldMove(
        {
          host: saved.host,
          port: Number(saved.port),
          username: saved.username,
          sslMode: saved.ssl_mode ? toSslMode(saved.ssl_mode) : sslModeFromLegacyBoolean(saved.ssl),
        },
        { host: value.host, port: value.port, username: value.username, sslMode: value.ssl_mode }
      );
      if (moved) {
        return reply(
          { error: REENTER_PASSWORD_MESSAGE, errors: { password: REENTER_PASSWORD_MESSAGE } },
          { status: 400 }
        );
      }
    }

    // A kept connection string carries the saved password inside it, and the
    // TLS mode on screen decides how it travels. So it may not travel less
    // protected than before, the same rule the loose fields follow above.
    const keepsSavedConnString =
      !clearConnectionString && value.connection_string === "" && storedConnString !== "";
    if (keepsSavedConnString) {
      const saved = existing.rows[0];
      const savedMode = saved.ssl_mode ? toSslMode(saved.ssl_mode) : sslModeFromLegacyBoolean(saved.ssl);
      if (tlsWouldWeaken(savedMode, value.ssl_mode)) {
        return reply(
          {
            error: REENTER_CONNECTION_STRING_MESSAGE,
            errors: { connection_string: REENTER_CONNECTION_STRING_MESSAGE },
          },
          { status: 400 }
        );
      }
    }

    // A stored test result describes the target that was reached, so it only
    // stays true while the target does. Renaming a connection or relabelling
    // its environment leaves it alone; repointing it — different host, port,
    // database, user, TLS setting or credential — makes it describe somewhere
    // else, so it is cleared and the row goes back to "never tested".
    //
    // Re-typing the same password also clears it: what is compared here is a
    // plaintext field against a stored ciphertext, so they never match. That
    // errs toward asking for a fresh test, which is the safe way to be wrong.
    const before = existing.rows[0];
    const targetChanged =
      before.host !== value.host ||
      Number(before.port) !== value.port ||
      before.database_name !== value.database_name ||
      before.username !== value.username ||
      (before.ssl_mode ?? "") !== value.ssl_mode ||
      effectivePassword !== storedPassword ||
      effectiveConnString !== storedConnString;

    // Before the UPDATE below, so its RETURNING sends back the cleared values
    // rather than the ones that have just stopped being true.
    if (targetChanged) {
      await pool.query(
        `UPDATE connections
            SET last_tested_at = NULL,
                last_test_ok = NULL,
                last_test_version = NULL,
                last_test_latency_ms = NULL,
                last_test_error = NULL
          WHERE id = $1 AND org_id = $2`,
        [id, principal.orgId]
      );
    }

    // Where the password lives after the save. The form says with
    // `local_only`; without it the connection stays where it is. A local one
    // is written to this machine's store first, then the shared row gets its
    // marker; one moving back to the cloud takes its password with it.
    const wasLocal = marker !== null;
    const local = wantsLocal(body, () => false, wasLocal);
    const localKey = local ? (marker?.key ?? randomUUID()) : null;
    if (localKey) {
      try {
        await saveLocalSecret(localKey, { password: effectivePassword, connectionString: effectiveConnString });
      } catch (error) {
        console.error("PUT connection: the local password store could not be written:", error);
        return reply(
          { error: `The password could not be saved on ${localMachineName()}. Check its local database (LOCAL_DATABASE_URL).` },
          { status: 500 }
        );
      }
      undoLocalSave = held ? () => saveLocalSecret(localKey, held) : () => deleteLocalSecret(localKey);
    }
    const movesPassword = local || wasLocal;
    const passwordValue = local
      ? makeLocalMarker(localKey!, localMachineName())
      : wasLocal
        ? (encryptSecret(effectivePassword) ?? "")
        : // Encrypt only a value the user actually typed; "" still means "keep".
          (encryptSecret(value.password) ?? "");
    const connStringValue =
      wasLocal && !local ? (encryptSecret(effectiveConnString) ?? "") : (encryptSecret(value.connection_string) ?? "");

    const result = await pool.query(
      `
      UPDATE connections
      SET name = $1,
          host = $2,
          port = $3,
          database_name = $4,
          type = $5,
          username = $6,
          password = CASE WHEN $15::boolean THEN $7 WHEN $7 = '' THEN password ELSE $7 END,
          connection_string = CASE
            WHEN $8 THEN NULL
            WHEN $15::boolean THEN NULLIF($9, '')
            WHEN $9 = '' THEN connection_string
            ELSE $9
          END,
          ssl = $10,
          ssl_mode = $11,
          environment = $12,
          application_table = $13,
          execute_role = $14,
          version = version + 1,
          updated_at = now(),
          updated_by = $18
      WHERE id = $16 AND org_id = $17
        AND ($19::int IS NULL OR version = $19::int)
      RETURNING ${PUBLIC_COLUMNS}
      `,
      [
        value.name,
        value.host,
        value.port,
        value.database_name,
        value.type,
        value.username,
        passwordValue,
        local || clearConnectionString,
        connStringValue,
        sslModeUsesTls(value.ssl_mode),
        value.ssl_mode,
        value.environment,
        value.application_table,
        value.execute_role,
        movesPassword,
        id,
        principal.orgId,
        savedBy(principal),
        startedFrom,
      ]
    );

    // Someone saved between the read above and this write: the version check
    // in the WHERE is what makes the two of them one decision.
    if (result.rows.length === 0) {
      if (undoLocalSave) await undoLocalSave();
      return startedFrom !== null ? conflict(principal, id) : reply({ error: "Connection not found." }, { status: 404 });
    }
    // Back in the cloud: the password is in the shared row now.
    if (marker && !local) await deleteLocalSecret(marker.key);

    return reply(publicRow(result.rows[0]));
  } catch (error) {
    if (undoLocalSave) await undoLocalSave().catch(() => undefined);
    console.error("PUT connection error:", error);
    return reply({ error: "Failed to update connection." }, { status: 500 });
  }
}

export async function deleteConnection(
  principal: Principal,
  body: Record<string, unknown>
): Promise<WriteAnswer> {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply({ error: "Connection ID is required." }, { status: 400 });
  }

  try {
    await syncMetadataTables();

    const existing = await pool.query<{
      name: string;
      environment: string | null;
      version: number;
      site_id: number | null;
      password: string | null;
    }>(
      `SELECT name, environment, version, site_id, password FROM connections WHERE id = $1 AND org_id = $2`,
      [id, principal.orgId]
    );
    // Another organization's connection reads as missing, the same answer a
    // deleted one gets, so this cannot be used to learn which ids exist.
    if (existing.rows.length === 0) {
      return reply({ error: "Connection not found." }, { status: 404 });
    }
    if (existing.rows[0].site_id != null) {
      return reply({ error: SITE_OWNED_MESSAGE, siteOwned: true }, { status: 409 });
    }
    // Deleting a connection someone has just changed is worth a second look:
    // they may have pointed it somewhere that is still wanted.
    const startedFrom = baseVersion(body);
    if (startedFrom !== null && startedFrom !== Number(existing.rows[0].version)) {
      return conflict(principal, id);
    }

    // Deleting a production connection and saving the database again as "dev"
    // would take the label off as surely as editing it, so it needs the same
    // permission. See lib/environment-guard.
    if (
      toEnvironment(existing.rows[0].environment) === "prod" &&
      !hasPermission(principal, UNLABEL_PRODUCTION_PERMISSION)
    ) {
      return reply(
        { error: unlabelRefusal(`connection "${existing.rows[0].name}"`, "delete") },
        { status: 403 }
      );
    }

    // tracked_schemas deliberately has no foreign key to connections (see the
    // note in lib/lineage-db), so deleting a connection silently orphans every
    // tracked schema, snapshot and drift event that pointed at it. Saved
    // comparison sets do have one, but it is ON DELETE SET NULL — they survive
    // and keep the label, they just lose the way to reach the database. Either
    // way something the user built stops working, so say what and make them
    // confirm.
    const dependents = await getConnectionDependents(principal.orgId, id);
    const inUse = dependents.trackedSchemas > 0 || dependents.comparisonSets > 0;
    if (inUse && body.confirm !== true) {
      const uses: string[] = [];
      if (dependents.trackedSchemas > 0) {
        uses.push(
          `${dependents.trackedSchemas} tracked schema${dependents.trackedSchemas === 1 ? "" : "s"}`
        );
      }
      if (dependents.comparisonSets > 0) {
        uses.push(
          `${dependents.comparisonSets} saved comparison set${dependents.comparisonSets === 1 ? "" : "s"}`
        );
      }

      let error = `"${existing.rows[0].name}" is still used by ${uses.join(" and ")}.`;
      // Only worth a sentence when there is actually history to lose — "removes
      // 0 snapshots" reads like a bug, not a warning.
      if (dependents.snapshots > 0) {
        error +=
          ` Deleting it also removes ${dependents.snapshots} snapshot` +
          `${dependents.snapshots === 1 ? "" : "s"} and ` +
          `${dependents.snapshots === 1 ? "its" : "their"} drift history.`;
      }
      if (dependents.comparisonSets > 0) {
        error +=
          ` The set${dependents.comparisonSets === 1 ? "" : "s"} will be kept, but ` +
          `${dependents.comparisonSets === 1 ? "its" : "their"} side pointing here ` +
          `will need a new connection before ${dependents.comparisonSets === 1 ? "it" : "they"} ` +
          `can run again.`;
      }

      return reply(
        { error, dependents, needsConfirmation: true },
        { status: 409 }
      );
    }

    const { rowCount } = await pool.query(
      "DELETE FROM connections WHERE id = $1 AND org_id = $2 AND ($3::int IS NULL OR version = $3::int)",
      [id, principal.orgId, startedFrom]
    );
    if (rowCount === 0 && startedFrom !== null) return conflict(principal, id);

    // A local connection can be deleted from anywhere. Its password goes too
    // when it was kept here; one kept on another machine stays there, unused.
    const marker = parseLocalMarker(existing.rows[0].password);
    if (marker && localSecretFor(marker.key)) await deleteLocalSecret(marker.key);

    return reply({ success: true, dependents });
  } catch (error) {
    console.error("DELETE connection error:", error);
    return reply({ error: "Failed to delete connection." }, { status: 500 });
  }
}
