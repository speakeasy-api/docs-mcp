import { CopyButton } from "./CopyButton.js";

export function ServerUrl({ url }: { url: string }) {
  return (
    <div className="pg-section">
      <h2 className="pg-heading">Endpoint</h2>
      <div className="pg-url-block">
        <code>{url}</code>
        <CopyButton text={url} />
      </div>
    </div>
  );
}
