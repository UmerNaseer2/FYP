"use client";

type Connection = {
  id: number;
  name: string;
  database_name: string;
};

type VersionSelectorProps = {
  connections: Connection[];
  schemas: string[];
  selectedConnectionId: number;
  schemaA: string;
  schemaB: string;
};

export default function VersionSelector({
  connections,
  schemas,
  selectedConnectionId,
  schemaA,
  schemaB,
}: VersionSelectorProps) {
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.currentTarget.form?.requestSubmit();
  };

  return (
    <form className="version-selector">
      <select
        name="connection"
        className="version-select"
        defaultValue={selectedConnectionId}
        onChange={autoSubmit}
      >
        {connections.map((conn) => (
          <option key={conn.id} value={conn.id}>
            {conn.name} ({conn.database_name})
          </option>
        ))}
      </select>

      <select name="schemaA" className="version-select" defaultValue={schemaA}>
        {schemas.map((schema) => (
          <option key={schema} value={schema}>
            Schema A: {schema}
          </option>
        ))}
      </select>

      <select name="schemaB" className="version-select" defaultValue={schemaB}>
        {schemas.map((schema) => (
          <option key={schema} value={schema}>
            Schema B: {schema}
          </option>
        ))}
      </select>

      <button className="version-btn" type="submit">
        Check Version
      </button>
    </form>
  );
}