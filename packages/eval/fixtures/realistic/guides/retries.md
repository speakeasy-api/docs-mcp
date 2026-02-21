# Retries Guide

Use a bounded retry strategy with jitter for resilient clients.

## Handling 429 Errors

When the API returns HTTP 429, respect Retry-After and retry with exponential backoff.

## Backoff Strategy

Use full jitter and cap max delay to avoid stampedes during partial outages.
