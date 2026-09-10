export function MetadataValues({ value, source }: { value: unknown; source: string }) {
  return (
    <section className="metadata-values" aria-label="Item metadata">
      <h3>Item metadata <span>{source}</span></h3>
      {value === undefined ? <p>No readable metadata found.</p> : <MetadataFields value={value} />}
    </section>
  );
}

function MetadataFields({ value }: { value: unknown }) {
  if (value === null) return <span className="metadata-empty">null</span>;
  if (typeof value !== "object") {
    return <span>{value === "" ? <span className="metadata-empty">Empty string</span> : String(value)}</span>;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="metadata-empty">{Array.isArray(value) ? "Empty list" : "Empty object"}</span>;
  return (
    <dl className="metadata-fields">
      {entries.map(([key, field]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            {field !== null && typeof field === "object" && Object.keys(field).length > 0 ? (
              <details open={key === "data" || key === "emoteDataADR74"}>
                <summary>{Object.keys(field).length} {Array.isArray(field) ? "items" : "fields"}</summary>
                <MetadataFields value={field} />
              </details>
            ) : <MetadataFields value={field} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}
