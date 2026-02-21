import { useState, useEffect } from "react";
import { Chat, ElementsConfig, GramElementsProvider } from "@gram-ai/elements";
import { ServerUrl } from "./components/ServerUrl.js";
import { InstallMethods } from "./components/InstallMethods.js";
import { ToolsList } from "./components/ToolsList.js";

const getSession = async () => {
  return fetch("/chat/session", {
    method: "POST",
    headers: { "Gram-Project": "thomas" },
  })
    .then((res) => res.json())
    .then((data) => data.client_token);
};

export default function Playground() {
  const mcpUrl = `${window.location.origin}/mcp`;
  const [token, setToken] = useState<string | undefined>();
  const [serverName, setServerName] = useState<string | undefined>();

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setToken(data.token);
        if (data.serverName) setServerName(data.serverName);
      })
      .catch(() => {});
  }, []);

  const config: ElementsConfig = {
    projectSlug: "thomas",
    mcp: mcpUrl,
    variant: "standalone",
    api: {
      session: getSession,
    },
  };

  return (
    <GramElementsProvider config={config}>
      <div className="pg-info-panel">
        <ServerUrl url={mcpUrl} />
        <InstallMethods serverUrl={mcpUrl} serverName={serverName} token={token} />
        <ToolsList />
      </div>
      <Chat />
    </GramElementsProvider>
  );
}
