interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
  default?: unknown;
  required?: string[];
}

function SchemaProperty({
  name,
  schema,
  required,
  depth,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  depth: number;
}) {
  const typeLabel = schema.enum
    ? `enum(${schema.enum.join(" | ")})`
    : schema.type === "array" && schema.items?.type
      ? `${schema.items.type}[]`
      : schema.type || "unknown";

  return (
    <div className="pg-schema-prop" style={{ paddingLeft: depth * 16 }}>
      <div className="pg-schema-row">
        <code className="pg-schema-name">{name}</code>
        <span className="pg-schema-type">{typeLabel}</span>
        {required && <span className="pg-badge">required</span>}
        {schema.default !== undefined && (
          <span className="pg-schema-default">
            = {JSON.stringify(schema.default)}
          </span>
        )}
      </div>
      {schema.description && (
        <p className="pg-schema-desc">{schema.description}</p>
      )}
      {schema.type === "object" && schema.properties && (
        <div className="pg-schema-nested">
          {Object.entries(schema.properties).map(([key, val]) => (
            <SchemaProperty
              key={key}
              name={key}
              schema={val}
              required={schema.required?.includes(key) ?? false}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
      {schema.type === "array" &&
        schema.items?.type === "object" &&
        schema.items.properties && (
          <div className="pg-schema-nested">
            {Object.entries(schema.items.properties).map(([key, val]) => (
              <SchemaProperty
                key={key}
                name={key}
                schema={val}
                required={schema.items!.required?.includes(key) ?? false}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
    </div>
  );
}

export function SchemaView({
  schema,
}: {
  schema: JsonSchema;
}) {
  if (!schema.properties) return null;

  return (
    <div className="pg-schema">
      {Object.entries(schema.properties).map(([key, val]) => (
        <SchemaProperty
          key={key}
          name={key}
          schema={val}
          required={schema.required?.includes(key) ?? false}
          depth={0}
        />
      ))}
    </div>
  );
}
