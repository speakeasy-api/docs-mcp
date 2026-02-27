export async function mcpPost(
  body: unknown,
  sessionId?: string,
): Promise<{ data: unknown; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  const res = await fetch("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const returnedSessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        return { data: JSON.parse(line.slice(6)), sessionId: returnedSessionId };
      }
    }
    return { data: null, sessionId: returnedSessionId };
  }
  if (!contentType.includes("application/json")) {
    return { data: null, sessionId: returnedSessionId };
  }
  return { data: await res.json(), sessionId: returnedSessionId };
}

export async function initMcpSession(): Promise<string | undefined> {
  const init = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "docs-mcp-playground", version: "0.1.0" },
    },
  });
  const sessionId = init.sessionId;
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return sessionId;
}
