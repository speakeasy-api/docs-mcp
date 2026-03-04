---
title: AcmeAuth Integration Advisor
description: Generate implementation guidance using AcmeAuth authentication, rate limiting, and webhook docs.
arguments:
  - name: app_type
    title: Application Type
    description: The kind of application being integrated (for example SPA, backend API, or mobile app)
    required: true
  - name: auth_method
    title: Authentication Method
    description: Preferred authentication method (api-key, oauth2, or jwt)
    required: true
  - name: expected_traffic
    title: Expected Traffic
    description: Estimated request volume or plan tier expectations
---

You are helping integrate AcmeAuth for a {{app_type}}.

Use {{auth_method}} as the primary authentication method unless there is a clear mismatch.
In your answer:

1. Recommend an implementation approach based on the Authentication guide.
2. Explain how to handle limits for {{expected_traffic}} using the Rate Limiting guide.
3. Add webhook setup and signature verification steps from the Webhooks guide.
4. Include a short failure-handling checklist (401/403, 429, webhook retries).
