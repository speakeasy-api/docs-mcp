---
mcp_metadata:
  scope: global-guide
---

# Webhooks

Webhooks allow your application to receive real-time notifications when events occur in AcmeAuth.

## Overview

Instead of polling the API for changes, webhooks push event data to your server as they happen. This is more efficient and provides lower latency for event processing.

## Setting Up Webhooks

To receive webhook events, you need to:

1. Create a webhook endpoint in your application
2. Register the endpoint URL in the AcmeAuth dashboard
3. Select which events to subscribe to
4. Verify incoming webhook signatures

## Event Types

AcmeAuth sends webhooks for the following event categories:

- `user.created` - A new user signed up
- `user.updated` - User profile was modified
- `session.created` - New login session started
- `session.revoked` - A session was terminated
- `key.rotated` - An API key was rotated
- `permission.changed` - User permissions were updated

## Signature Verification

All webhook payloads are signed using HMAC-SHA256. Verify the signature before processing any webhook:

1. Extract the `X-AcmeAuth-Signature` header
2. Compute HMAC-SHA256 of the raw request body using your webhook secret
3. Compare the computed signature with the header value

### Timing-Safe Comparison

Always use a constant-time comparison function to prevent timing attacks when comparing signatures.

## Retry Policy

If your endpoint returns a non-2xx status code, AcmeAuth will retry the delivery:

- 1st retry: 30 seconds
- 2nd retry: 5 minutes
- 3rd retry: 30 minutes
- 4th retry: 2 hours
- 5th retry: 24 hours

After 5 failed attempts, the webhook is marked as failed and can be manually retried from the dashboard.
