// Window events the studio's parts use to reach each other without passing
// props through every page. Kept out of the "use client" files so a server
// file can import the names too.

/** Opens the Ask AI panel (components/studio/SchemaChat), from the command bar. */
export const OPEN_ASK_AI_EVENT = "schema-studio:open-ask-ai";
