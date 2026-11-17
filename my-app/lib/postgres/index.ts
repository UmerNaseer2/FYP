/**
 * The public face of lib/postgres. Everything outside this folder imports
 * from here; the files inside import each other directly. See README.md for
 * what lives where.
 */
export { POOL_MAX, getPoolForConfig } from "./pool";
export { normalizeDefinition, stripSchemaFromExpr, withCurrentNormalization } from "./normalize";
export {
  MANAGED_SCHEMAS,
  fetchSchemaNames,
  fetchSchemaSnapshot,
  withoutToolTables,
} from "./snapshot";
export type {
  CollationProvider,
  CollationSnapshot,
  ColumnSnapshot,
  CompareTarget,
  ConstraintKind,
  ConstraintSnapshot,
  DomainCheck,
  ExtensionSnapshot,
  ForeignKeySnapshot,
  GeneratedColumn,
  IndexSnapshot,
  PolicySnapshot,
  PrivilegeGrant,
  PrivilegeObjectKind,
  PrivilegeSnapshot,
  RangeDetails,
  RoutineSnapshot,
  RowSecuritySnapshot,
  SchemaSnapshot,
  SequenceOptions,
  SequenceSnapshot,
  TablePartitioning,
  TableSnapshot,
  TriggerSnapshot,
  TypeKind,
  TypeSnapshot,
  ViewSnapshot,
} from "./types";

// Moved to lib/postgres/snapshot-facts so the screens can ask it without importing this
// module — importing a VALUE from here pulls the node-only `pg` client into the
// browser bundle. Re-exported so the server-side callers read the same way.
export { rangeTypeIsCreatable } from "./snapshot-facts";
