# Python SDK

The AcmeAuth Python SDK provides an idiomatic Python client for the AcmeAuth API.

## Installation

Install using pip:

```bash
pip install acmeauth
```

## Quick Start

Initialize the client with your API key:

```python
from acmeauth import AcmeAuth

client = AcmeAuth(api_key="sk_live_xxxxxxxxxxxx")

user = client.users.get("user_123")
print(user.email)
```

## Authentication

### API Key

```python
client = AcmeAuth(api_key="sk_live_xxxxxxxxxxxx")
```

### OAuth Token

```python
client = AcmeAuth(access_token="eyJ...")
```

## Error Handling

The SDK raises typed exceptions:

```python
from acmeauth import AcmeAuthError, RateLimitError

try:
    user = client.users.get("user_123")
except RateLimitError as e:
    print(f"Rate limited, retry after {e.retry_after}ms")
except AcmeAuthError as e:
    print(f"API error: {e.message} ({e.code})")
```

## Async Support

The SDK provides an async client:

```python
from acmeauth import AsyncAcmeAuth

async_client = AsyncAcmeAuth(api_key="sk_live_xxxxxxxxxxxx")

user = await async_client.users.get("user_123")
```

## Pagination

```python
for user in client.users.list(limit=50):
    print(user.email)
```

## Webhooks

```python
from acmeauth import verify_webhook_signature

is_valid = verify_webhook_signature(
    payload=raw_body,
    signature=request.headers["x-acmeauth-signature"],
    secret=os.environ["WEBHOOK_SECRET"],
)
```
