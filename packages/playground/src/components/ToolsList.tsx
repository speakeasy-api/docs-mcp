import { useState, useEffect } from "react";
import { useElements } from "@gram-ai/elements";
import { SchemaView } from "./SchemaView.js";
import { mcpPost, initMcpSession } from "../lib/mcp.js";

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

function useToolsFromMcp(): ToolEntry[] | undefined {
  const [tools, setTools] = useState<ToolEntry[] | undefined>();

  useEffect(() => {
    (async () => {
      const sessionId = await initMcpSession();
      const { data } = await mcpPost(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );
      const typed = data as {
        result?: {
          tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
        };
      } | null;

      if (!typed) return setTools([]);
      const result = typed.result?.tools ?? [];
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
