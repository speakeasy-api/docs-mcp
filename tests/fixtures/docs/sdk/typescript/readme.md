# TypeScript SDK

The AcmeAuth TypeScript SDK provides a type-safe client for the AcmeAuth API.

## Installation

Install the SDK using your preferred package manager:

```bash
npm install @acmeauth/sdk
# or
pnpm add @acmeauth/sdk
```

## Quick Start

Initialize the client with your API key:

```typescript
import { AcmeAuth } from "@acmeauth/sdk";

const client = new AcmeAuth({
  apiKey: process.env.ACMEAUTH_API_KEY,
});

const user = await client.users.get("user_123");
console.log(user.email);
```

## Authentication

The TypeScript SDK supports all authentication methods:

### API Key

```typescript
const client = new AcmeAuth({
  apiKey: "sk_live_xxxxxxxxxxxx",
});
```

### OAuth Token

```typescript
const client = new AcmeAuth({
  accessToken: "eyJ...",
});
```

## Error Handling

The SDK throws typed errors that you can catch and handle:

```typescript
import { AcmeAuthError, RateLimitError } from "@acmeauth/sdk";

try {
  const user = await client.users.get("user_123");
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log(`Rate limited, retry after ${error.retryAfter}ms`);
  } else if (error instanceof AcmeAuthError) {
    console.log(`API error: ${error.message} (${error.code})`);
  }
}
```

## Pagination

List endpoints return paginated results:

```typescript
for await (const user of client.users.list({ limit: 50 })) {
  console.log(user.email);
}
```

## Webhooks

Verify incoming webhooks using the SDK:

```typescript
import { verifyWebhookSignature } from "@acmeauth/sdk";

const isValid = verifyWebhookSignature({
  payload: rawBody,
  signature: req.headers["x-acmeauth-signature"],
  secret: process.env.WEBHOOK_SECRET,
});
```
