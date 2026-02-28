import { useState } from "react";
import { CopyButton } from "./CopyButton.js";
import { clientIcons } from "./ClientIcons.js";

interface ClientConfig {
  id: string;
  name: string;
  snippet: string;
  deepLink?: string;
}

function getClients(serverUrl: string, serverName: string, token?: string): ClientConfig[] {
  const headerLine = token
    ? `\n      "headers": {\n        "Authorization": "Bearer ${token}"\n      }`
    : "";

  const cursorConfig = JSON.stringify({
    url: serverUrl,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });

  const vscodeConfig = JSON.stringify({
    name: serverName,
    type: "http",
    url: serverUrl,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });

  return [
    {
      id: "cursor",
      name: "Cursor",
      deepLink: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(serverName)}&config=${encodeURIComponent(cursorConfig)}`,
      snippet: `{\n  "mcpServers": {\n    "${serverName}": {\n      "url": "${serverUrl}"${headerLine}\n    }\n  }\n}`,
    },
    {
      id: "claude-code",
      name: "Claude Code",
      snippet: token
        ? `claude mcp add --transport http ${serverName} ${serverUrl} --header "Authorization: Bearer ${token}"`
        : `claude mcp add --transport http ${serverName} ${serverUrl}`,
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      snippet: token
        ? `{\n  "mcpServers": {\n    "${serverName}": {\n      "command": "npx",\n      "args": [\n        "mcp-remote@latest",\n        "${serverUrl}",\n        "--header",\n        "Authorization: Bearer ${token}"\n      ]\n    }\n  }\n}`
        : `{\n  "mcpServers": {\n    "${serverName}": {\n      "command": "npx",\n      "args": [\n        "mcp-remote@latest",\n        "${serverUrl}"\n      ]\n    }\n  }\n}`,
    },
    {
      id: "vscode",
      name: "VS Code",
      deepLink: `vscode:mcp/install?${encodeURIComponent(vscodeConfig)}`,
      snippet: `{\n  "servers": {\n    "${serverName}": {\n      "type": "http",\n      "url": "${serverUrl}"${headerLine}\n    }\n  }\n}`,
    },
    {
      id: "windsurf",
      name: "Windsurf",
      snippet: `{\n  "mcpServers": {\n    "${serverName}": {\n      "serverUrl": "${serverUrl}"${headerLine}\n    }\n  }\n}`,
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      snippet: `{\n  "mcpServers": {\n    "${serverName}": {\n      "httpUrl": "${serverUrl}"${headerLine}\n    }\n  }\n}`,
    },
    {
      id: "codex",
      name: "Codex",
      snippet: token
        ? `[mcp_servers.${serverName}]\nurl = "${serverUrl}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }`
        : `[mcp_servers.${serverName}]\nurl = "${serverUrl}"`,
    },
  ];
}

export function InstallMethods({
  serverUrl,
  serverName = "speakeasy-docs",
  token,
}: {
  serverUrl: string;
  serverName?: string;
  token?: string;
}) {
  const clients = getClients(serverUrl, serverName, token);
  const [selected, setSelected] = useState<string | null>(null);
  const active = clients.find((c) => c.id === selected);

  return (
    <div className="pg-section">
      <h2 className="pg-heading">Add to your client</h2>
      <div className="pg-grid">
        {clients.map((client) => {
          const Icon = clientIcons[client.id];
          return (
            <button
              key={client.id}
              className="pg-client-btn"
              data-active={selected === client.id}
              onClick={() => setSelected(selected === client.id ? null : client.id)}
            >
              {Icon ? <Icon /> : <span className="pg-client-icon">{client.name[0]}</span>}
              {client.name}
            </button>
          );
        })}
      </div>
      {active && (
        <div className="pg-config-panel">
          <div className="pg-config-header">
            <h3 className="pg-config-title">{active.name}</h3>
            <div className="pg-config-actions">
              {active.deepLink && (
                <a
                  href={active.deepLink}
                  className="pg-deep-link"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Install &#8599;
                </a>
              )}
              <CopyButton text={active.snippet} />
            </div>
          </div>
          <div className="pg-config-code">
            <pre>
              <code>{active.snippet}</code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
