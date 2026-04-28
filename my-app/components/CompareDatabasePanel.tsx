import type { SchemaSnapshot } from "../lib/postgres";

export default function CompareDatabasePanel({
  displayName,
  schemaName,
  result,
}: {
  displayName: string;
  schemaName: string;
  result:
    | { ok: true; data: SchemaSnapshot }
    | { ok: false; error: string };
}) {
  return (
    <section className="compare-schema-panel">
      <h3 className="compare-schema-panel__title">
        Database:{" "}
        <span className="compare-schema-name">{displayName}</span>
      </h3>
      <p className="compare-hint compare-hint--tight">
        Schema <code className="compare-code">{schemaName}</code>
      </p>

      {result.ok ? (
        result.data.tables.length === 0 ? (
          <p className="compare-hint">No base tables in this schema.</p>
        ) : (
          <div className="compare-table-groups">
            {result.data.tables.map((table) => (
              <div key={table.name} className="compare-table-group">
                <h4 className="compare-table-group__name">{table.name}</h4>
                {table.columns.length === 0 ? (
                  <p className="compare-hint compare-hint--tight">No columns.</p>
                ) : (
                  <ul className="compare-column-list">
                    {table.columns.map((col) => (
                      <li key={col.name} className="compare-column-row">
                        <span className="compare-column-row__name">{col.name}</span>
                        <span className="compare-column-row__meta">
                          <code className="compare-column-type">
                            {col.typeDisplay}
                          </code>
                          <span
                            className={
                              col.nullable
                                ? "compare-null compare-null--yes"
                                : "compare-null compare-null--no"
                            }
                          >
                            {col.nullable ? "nullable" : "not null"}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )
      ) : (
        <p className="compare-hint compare-hint--error">{result.error}</p>
      )}
    </section>
  );
}
