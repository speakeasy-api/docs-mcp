---
mcp_metadata:
  scope: global-guide
---

# Authentication

Authentication is a critical component of any secure API integration.

## Overview

AcmeAuth provides multiple authentication mechanisms to suit different use cases:

- **API Keys** for server-to-server communication
- **OAuth 2.0** for user-delegated access
- **JWT Tokens** for stateless session management

Each method has its own trade-offs in terms of security, convenience, and scalability.

## API Key Authentication

API keys are the simplest form of authentication. They are typically used for server-to-server integrations where user context is not required.

To authenticate with an API key, include it in the `Authorization` header:

```
Authorization: Bearer sk_live_xxxxxxxxxxxx
```

API keys can be created and managed from the AcmeAuth dashboard. Each key can be scoped to specific permissions and rate limits.

### Key Rotation

Regular key rotation is a security best practice. AcmeAuth supports seamless key rotation:

1. Generate a new API key from the dashboard
2. Update your application to use the new key
3. Verify the new key works correctly
4. Revoke the old key

Both keys remain valid during the transition period (configurable, default 24 hours).

## OAuth 2.0

OAuth 2.0 is recommended when your application needs to act on behalf of users. AcmeAuth supports the Authorization Code flow with PKCE.

### Authorization Flow

1. Redirect the user to the AcmeAuth authorization endpoint
2. User grants permission
3. AcmeAuth redirects back with an authorization code
4. Exchange the code for access and refresh tokens
5. Use the access token to make API calls

### Token Refresh

Access tokens expire after 1 hour by default. Use the refresh token to obtain new access tokens without requiring user interaction.

## JWT Tokens

JSON Web Tokens provide a stateless authentication mechanism. AcmeAuth can issue JWTs that your services can verify locally without calling AcmeAuth servers.

### Token Structure

AcmeAuth JWTs contain:

- `sub`: The user or service account ID
- `iat`: Token issue time
- `exp`: Token expiration time
- `scope`: Granted permissions
- `aud`: Intended audience (your service)

### Verification

Verify tokens using AcmeAuth's public JWKS endpoint at `/.well-known/jwks.json`.
