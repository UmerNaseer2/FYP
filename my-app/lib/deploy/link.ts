/**
 * The query string that opens the Deploy page on a version just saved or
 * pushed, so the person does not have to pick the connection, schema, script
 * group and version again. The Deploy page reads these four names from the
 * address. Without a saved connection there is nothing to pick, so the link
 * stays plain.
 */
export function deployLinkQuery(
  connectionId: number | null,
  schema: string,
  scriptName: string,
  version: string
): string {
  if (connectionId === null) return "";
  const params = new URLSearchParams({
    connection: String(connectionId),
    schema,
    script: scriptName,
    version,
  });
  return `?${params.toString()}`;
}
