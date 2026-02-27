import { useState, useEffect } from "react";
import { useElements } from "@gram-ai/elements";
import { SchemaView } from "./SchemaView.js";

interface ToolEntry {
  name: string;
  description?: string;
  jsonSchema?: Record<string, unknown>;
}

function useToolsFromElements(): ToolEntry[] | undefined {
  const { mcpTools } = useElements();
  const [tools, setTools] = useState<ToolEntry[]>();

  useEffect(() => {
    if (!mcpTools) return;
    const entries = Object.entries(mcpTools);
    Promise.all(
      entries.map(async ([name, tool]) => {
        const t = tool as {
          description?: string;
          inputSchema?: { jsonSchema?: unknown | PromiseLike<unknown> };
        };
        let jsonSchema: Record<string, unknown> | undefined;
        if (t.inputSchema?.jsonSchema) {
          const resolved = await t.inputSchema.jsonSchema;
          jsonSchema = resolved as Record<string, unknown>;
        }
        return { name, description: t.description, jsonSchema };
      }),
    ).then(setTools);
  }, [mcpTools]);

  return tools;
}

async function mcpPost(body: unknown): Promise<unknown> {
  const res = await fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        return JSON.parse(line.slice(6));
      }
    }
    return null;
  }
  return res.json();
}

function useToolsFromMcp(): ToolEntry[] | undefined {
  const [tools, setTools] = useState<ToolEntry[] | undefined>();

  useEffect(() => {
    (async () => {
      // 1. Initialize handshake
      await mcpPost({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "docs-mcp-playground", version: "0.1.0" },
        },
      });

      // 2. Send initialized notification (no id — it's a notification)
      await mcpPost({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      // 3. Now list tools
      const data = (await mcpPost({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as {
        result?: {
          tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
        };
      } | null;

      if (!data) return setTools([]);
      const result = data.result?.tools ?? [];
      setTools(
        result.map((t) => ({
          name: t.name,
          description: t.description,
          jsonSchema: t.inputSchema,
        })),
      );
    })().catch(() => setTools([]));
  }, []);

  return tools;
}

function ToolsListInner({ tools }: { tools: ToolEntry[] | undefined }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const loading = tools === undefined;
  const ftsOnly = tools?.some((t) => t.description?.includes("lexical query")) ?? false;

  return (
    <div className="pg-section">
      <h2 className="pg-heading">Available Tools</h2>
      {ftsOnly && (
        <p className="pg-warning">
          Semantic search is unavailable — set OPENAI_API_KEY to enable semantic search results.
        </p>
      )}
      {loading && (
        <div className="pg-skeleton-list">
          {[1, 2].map((i) => (
            <div key={i} className="pg-skeleton" />
          ))}
        </div>
      )}
      {!loading && tools.length === 0 && <p className="pg-muted">No tools available.</p>}
      <div className="pg-tools-grid">
        {(tools ?? []).map((tool) => (
          <div key={tool.name} className="pg-tool-card">
            <button
              className="pg-tool-header"
              onClick={() => setExpanded(expanded === tool.name ? null : tool.name)}
              aria-expanded={expanded === tool.name}
            >
              <div>
                <span className="pg-tool-name">{tool.name}</span>
                {tool.description && <p className="pg-tool-desc">{tool.description}</p>}
              </div>
              <span className="pg-tool-chevron" data-expanded={expanded === tool.name}>
                &#9654;
              </span>
            </button>
            {expanded === tool.name && tool.jsonSchema && (
              <div className="pg-tool-body">
                <SchemaView
                  schema={
                    tool.jsonSchema as Record<string, unknown> & {
                      properties?: Record<string, unknown>;
                      required?: string[];
                    }
                  }
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolsListWithElements() {
  const tools = useToolsFromElements();
  return <ToolsListInner tools={tools} />;
}

function ToolsListWithMcp() {
  const tools = useToolsFromMcp();
  return <ToolsListInner tools={tools} />;
}

export function ToolsList({ chatEnabled }: { chatEnabled: boolean }) {
  if (chatEnabled) {
    return <ToolsListWithElements />;
  }
  return <ToolsListWithMcp />;
}
