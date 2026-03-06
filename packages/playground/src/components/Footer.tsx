export function Footer({
  serverName,
  serverVersion,
  serverCommit,
  serverBuildDate,
}: {
  serverName?: string;
  serverVersion?: string;
  serverCommit?: string;
  serverBuildDate?: string;
}) {
  const items = [
    ...(serverName ? [serverName] : []),
    ...(serverVersion ? [`v${serverVersion}`] : []),
    ...(serverCommit ? [`commit ${serverCommit}`] : []),
    ...(serverBuildDate ? [`built ${serverBuildDate}`] : []),
  ];

  if (items.length === 0) {
    return null;
  }

  return (
    <footer className="pg-footer" aria-label="Server metadata">
      {items.map((item, index) => (
        <span key={item}>
          {index > 0 && <span aria-hidden="true"> &#183; </span>}
          {item}
        </span>
      ))}
    </footer>
  );
}
