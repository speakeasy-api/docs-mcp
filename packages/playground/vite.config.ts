import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

function authPlugin(): Plugin {
  return {
    name: "playground-auth",
    configureServer(server) {
      const password = process.env.PLAYGROUND_PASSWORD;
      if (!password) return;

      const COOKIE_NAME = "pg_auth";
      const expectedHash = crypto.createHash("sha256").update(password).digest("hex").slice(0, 32);

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

      function parseCookies(header?: string): Record<string, string> {
        const cookies: Record<string, string> = {};
        if (!header) return cookies;
        for (const pair of header.split(";")) {
          const [key, ...rest] = pair.trim().split("=");
          if (key) cookies[key] = rest.join("=");
        }
        return cookies;
      }

      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

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
              res.end(LOGIN_HTML.replace("<!--ERROR-->", '<p class="error">Wrong password</p>'));
            }
          });
          return;
        }

        const cookies = parseCookies(req.headers.cookie);
        if (cookies[COOKIE_NAME] === expectedHash) return next();

        const auth = req.headers.authorization;
        if (auth?.startsWith("Bearer ") && auth.slice(7) === password) return next();

        if (url.searchParams.get("token") === password) return next();

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
      });
    },
  };
}

function apiPlugin(): Plugin {
  return {
    name: "playground-api",
    configureServer(server) {
      const password = process.env.PLAYGROUND_PASSWORD;
      const serverName = process.env.SERVER_NAME || "speakeasy-docs";
      const chatEnabled = !!process.env.GRAM_API_KEY;

      server.middlewares.use((req, res, next) => {
        if (req.url === "/api/config" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ...(password ? { token: password } : {}),
              serverName,
              chatEnabled,
            }),
          );
          return;
        }
        next();
      });

      if (chatEnabled) {
        const USER_ID_COOKIE = "pg_uid";
        let handlersPromise: ReturnType<
          typeof import("@gram-ai/elements/server").createElementsServerHandlers
        > | null = null;

        async function getHandlers() {
          if (!handlersPromise) {
            const { createElementsServerHandlers } = await import("@gram-ai/elements/server");
            handlersPromise = createElementsServerHandlers();
          }
          return handlersPromise;
        }

        server.middlewares.use((req, res, next) => {
          if (req.url === "/chat/session" && req.method === "POST") {
            const cookies: Record<string, string> = {};
            for (const pair of (req.headers.cookie || "").split(";")) {
              const [key, ...rest] = pair.trim().split("=");
              if (key) cookies[key] = rest.join("=");
            }
            let userId = cookies[USER_ID_COOKIE];
            if (!userId) {
              userId = crypto.randomUUID();
              res.setHeader(
                "Set-Cookie",
                `${USER_ID_COOKIE}=${userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`,
              );
            }
            getHandlers().then((handlers) => {
              handlers.session(req as any, res as any, {
                embedOrigin: process.env.EMBED_ORIGIN || "http://localhost:3000",
                userIdentifier: userId,
                expiresAfter: 3600,
              });
            });
            return;
          }
          next();
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [authPlugin(), apiPlugin(), react()],
  build: {
    outDir: "dist/client",
  },
  server: {
    port: 3000,
    proxy: {
      "/mcp": "http://localhost:20310",
    },
  },
});
