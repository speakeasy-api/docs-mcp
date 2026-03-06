import { useState, useEffect } from "react";
import { Chat, ElementsConfig, GramElementsProvider } from "@gram-ai/elements";
import { ServerUrl } from "./components/ServerUrl.js";
import { Footer } from "./components/Footer.js";
import { InstallMethods } from "./components/InstallMethods.js";
import { ToolsList } from "./components/ToolsList.js";
import { ResourcesList } from "./components/ResourcesList.js";

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
  const [serverVersion, setServerVersion] = useState<string | undefined>();
  const [serverCommit, setServerCommit] = useState<string | undefined>();
  const [serverBuildDate, setServerBuildDate] = useState<string | undefined>();
  const [chatEnabled, setChatEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setToken(data.token);
        if (data.serverName) setServerName(data.serverName);
        if (data.serverVersion) setServerVersion(data.serverVersion);
        if (data.serverCommit) setServerCommit(data.serverCommit);
        if (data.serverBuildDate) setServerBuildDate(data.serverBuildDate);
        setChatEnabled(!!data.chatEnabled);
      })
      .catch(() => {});
  }, []);

  const infoPanel = (
    <div className="pg-info-panel">
      <ServerUrl url={mcpUrl} />
      <InstallMethods serverUrl={mcpUrl} serverName={serverName} token={token} />
      <ToolsList chatEnabled={chatEnabled} />
      <ResourcesList />
      <Footer
        serverName={serverName}
        serverVersion={serverVersion}
        serverCommit={serverCommit}
        serverBuildDate={serverBuildDate}
      />
    </div>
  );

  if (!chatEnabled) {
    return infoPanel;
  }

  const config: ElementsConfig = {
    projectSlug: "thomas",
    mcp: mcpUrl,
    variant: "standalone",
    model: {
      showModelPicker: true,
    },
    api: {
      session: getSession,
    },
  };

  return (
    <GramElementsProvider config={config}>
      {infoPanel}
      <Chat />
    </GramElementsProvider>
  );
}
