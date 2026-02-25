#!/usr/bin/env node
import express from "express";
import crypto from "crypto";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "path";
import { fileURLToPath } from "url";
import type { IncomingMessage, ServerResponse } from "http";

const app = express();
const chatEnabled = !!process.env.GRAM_API_KEY;
const port = parseInt(process.env.PORT || "3001", 10);
const mcpTarget = process.env.MCP_TARGET || "http://localhost:20310";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Auth middleware (active when PLAYGROUND_PASSWORD is set) ---

const COOKIE_NAME = "pg_auth";

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MCP Playground — Login</title>
<style>
  *{box-sizing:border-box;margin:0}
  body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fafafa;color:#111}
  .card{background:#fff;padding:2.5rem 2rem;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 4px 12px rgba(0,0,0,.04);width:100%;max-width:340px}
  h1{font-size:1.15rem;font-weight:600;margin-bottom:1.5rem}
  input[type=password]{width:100%;padding:.625rem .75rem;border:1px solid #ddd;border-radius:6px;font-size:.95rem;outline:none;transition:border-color .15s}
  input[type=password]:focus{border-color:#888}
  button{width:100%;padding:.625rem;margin-top:.75rem;background:#111;color:#fff;border:none;border-radius:6px;font-size:.95rem;font-weight:500;cursor:pointer}
  button:hover{background:#333}
  .error{color:#d33;font-size:.85rem;margin-top:.625rem}
</style>
</head><body>
<div class="card">
  <h1>MCP Playground</h1>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Sign in</button>
    <!--ERROR-->
  </form>
</div>
</body></html>`;

function createAuthMiddleware(password: string) {
  const expectedHash = crypto
    .createHash("sha256")
    .update(password)
    .digest("hex")
    .slice(0, 32);

  function parseCookies(header?: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!header) return cookies;
    for (const pair of header.split(";")) {
      const [key, ...rest] = pair.trim().split("=");
      if (key) cookies[key] = rest.join("=");
    }
    return cookies;
  }

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );

    // Handle POST /login
    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        if (params.get("password") === password) {
          res.writeHead(302, {
            Location: "/",
            "Set-Cookie": `${COOKIE_NAME}=${expectedHash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            LOGIN_HTML.replace(
              "<!--ERROR-->",
              '<p class="error">Wrong password</p>',
            ),
          );
        }
      });
      return;
    }

    // Check cookie
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME] === expectedHash) return next();

    // Check Bearer token (for MCP clients)
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && auth.slice(7) === password) return next();

    // Check ?token= query param (for MCP client URLs)
    if (url.searchParams.get("token") === password) return next();

    // Not authenticated
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(LOGIN_HTML);
    } else {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
    }
  };
}

// --- App setup ---

const password = process.env.PLAYGROUND_PASSWORD;
if (password) {
  app.use(createAuthMiddleware(password));
}

app.use(
  createProxyMiddleware({
    target: mcpTarget,
    changeOrigin: true,
    pathFilter: "/mcp",
  }),
);

app.use(express.json());

const serverDisplayName = process.env.SERVER_NAME || "speakeasy-docs";

app.get("/api/config", (_req, res) => {
  res.json({
    ...(password ? { token: password } : {}),
    serverName: serverDisplayName,
    chatEnabled,
  });
});

if (chatEnabled) {
  const { createElementsServerHandlers } = await import(
    "@gram-ai/elements/server"
  );
  const handlers = createElementsServerHandlers();
  const USER_ID_COOKIE = "pg_uid";

  app.post("/chat/session", (req, res) => {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split(";")
        .map((c) => c.trim().split("="))
        .filter(([k]) => k),
    );
    let userId = cookies[USER_ID_COOKIE];
    if (!userId) {
      userId = crypto.randomUUID();
      res.setHeader(
        "Set-Cookie",
        `${USER_ID_COOKIE}=${userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`,
      );
    }
    handlers.session(req, res, {
      embedOrigin: process.env.EMBED_ORIGIN || `http://localhost:${port}`,
      userIdentifier: userId,
      expiresAfter: 3600,
    });
  });
}

// Serve built client assets in production
const clientDir = path.resolve(__dirname, "../dist/client");
app.use(express.static(clientDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
