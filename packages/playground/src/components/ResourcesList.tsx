import { useState, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mcpPost, initMcpSession } from "../lib/mcp.js";

interface ResourceEntry {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export function ResourcesList() {
  const [open, setOpen] = useState(false);
  const [resources, setResources] = useState<ResourceEntry[]>();
  const [sessionId, setSessionId] = useState<string>();
  const [expandedUri, setExpandedUri] = useState<string | null>(null);
  const [contentCache, setContentCache] = useState<Record<string, string>>({});
  const [loadingUri, setLoadingUri] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const sid = await initMcpSession();
      setSessionId(sid);
      const { data } = await mcpPost(
        { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
        sid,
      );
      const typed = data as {
        result?: { resources?: ResourceEntry[] };
      } | null;
      setResources(typed?.result?.resources ?? []);
    })().catch(() => setResources([]));
  }, []);

  const handleResourceClick = useCallback(
    async (uri: string) => {
      if (expandedUri === uri) {
        setExpandedUri(null);
        return;
      }
      setExpandedUri(uri);
      if (contentCache[uri]) return;
      setLoadingUri(uri);
      try {
        const { data } = await mcpPost(
          { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri } },
          sessionId,
        );
        const typed = data as {
          result?: { contents?: { text: string }[] };
        } | null;
        const text = typed?.result?.contents?.[0]?.text ?? "";
        setContentCache((prev) => ({ ...prev, [uri]: text }));
      } catch {
        setContentCache((prev) => ({ ...prev, [uri]: "Failed to load resource." }));
      } finally {
        setLoadingUri(null);
      }
    },
    [expandedUri, contentCache, sessionId],
  );

  // Hide the section entirely if there are no resources
  if (resources !== undefined && resources.length === 0) return null;

  const loading = resources === undefined;

  return (
    <div className="pg-section">
      <button className="pg-collapsible-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="pg-tool-chevron" data-expanded={open}>
          &#9654;
        </span>
        <span className="pg-heading">Resources</span>
        {!loading && resources && <span className="pg-count-badge">{resources.length}</span>}
      </button>

      {open && (
        <div className="pg-tools-grid">
          {loading && (
            <div className="pg-skeleton-list">
              {[1, 2, 3].map((i) => (
                <div key={i} className="pg-skeleton" style={{ height: 40 }} />
              ))}
            </div>
          )}
          {!loading &&
            resources?.map((resource) => {
              const isExpanded = expandedUri === resource.uri;
              const isLoading = loadingUri === resource.uri;
              return (
                <div key={resource.uri} className="pg-tool-card">
                  <button
                    className="pg-tool-header pg-resource-header"
                    onClick={() => handleResourceClick(resource.uri)}
                    aria-expanded={isExpanded}
                  >
                    <span className="pg-resource-name">{resource.name}</span>
                    <span className="pg-tool-chevron" data-expanded={isExpanded}>
                      &#9654;
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="pg-tool-body">
                      {isLoading && <div className="pg-skeleton" style={{ height: 100 }} />}
                      {!isLoading && contentCache[resource.uri] != null && (
                        <div className="pg-markdown">
                          <Markdown remarkPlugins={[remarkGfm]}>
                            {contentCache[resource.uri]}
                          </Markdown>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
