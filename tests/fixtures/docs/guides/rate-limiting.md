---
mcp_metadata:
  scope: global-guide
---

# Rate Limiting

AcmeAuth enforces rate limits to ensure fair usage and protect the platform from abuse.

## Default Limits

| Plan       | Requests/minute | Burst limit |
| ---------- | --------------- | ----------- |
| Free       | 60              | 10          |
| Pro        | 600             | 50          |
| Enterprise | 6000            | 500         |

## Rate Limit Headers

Every API response includes rate limit headers:

- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests in current window
- `X-RateLimit-Reset`: Unix timestamp when the window resets
- `Retry-After`: Seconds to wait (only on 429 responses)

## Handling Rate Limits

When you exceed the rate limit, the API returns a `429 Too Many Requests` response. Implement exponential backoff with jitter:

```
wait_time = min(base_delay * 2^attempt + random_jitter, max_delay)
```

## Best Practices

1. **Cache responses** when possible to reduce API calls
2. **Batch requests** using bulk endpoints where available
3. **Implement circuit breakers** to prevent cascading failures
4. **Monitor your usage** via the AcmeAuth dashboard
5. **Request limit increases** if you consistently hit limits
