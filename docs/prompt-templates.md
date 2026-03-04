# Prompt Templates

Docs MCP supports prompt templates that are discovered during `docs-mcp build` and exposed through MCP `prompts/list` and `prompts/get`.

## Why Use Prompt Templates

Prompt templates let you package reusable prompt workflows alongside your docs corpus so agents can discover and invoke them consistently.

## File Naming and Discovery

- Place prompt templates anywhere under your docs directory.
- Supported file types:
  - `*.template.md` (single-message shorthand)
  - `*.template.yaml` (structured, multi-message format)
- Prompt templates are excluded from search indexing (`search_docs` / `get_doc` corpus chunks).

Prompt names are derived from the relative file path without suffix:

- `guides/auth-integration.template.md` -> `guides/auth-integration`
- `guides/webhook-debug-playbook.template.yaml` -> `guides/webhook-debug-playbook`

## Conflict Rule (Markdown vs YAML)

If both `foo.template.md` and `foo.template.yaml` exist for the same derived prompt name:

- Docs MCP emits a warning during both `build` and `validate`
- YAML is preferred
- Markdown variant is ignored for that prompt name

## Mustache Templating

- Text content uses mustache placeholders (for example `{{auth_method}}`).
- At runtime, `prompts/get` renders placeholders using provided `arguments`.
- Required arguments are validated before rendering.

## Format: `*.template.md` (Shorthand)

Use this for simple prompts that return one `user` text message.

```md
---
title: AcmeAuth Integration Advisor
description: Generate implementation guidance using authentication, rate limiting, and webhook docs.
arguments:
  - name: app_type
    description: The kind of app being integrated
    required: true
  - name: auth_method
    description: Preferred auth method
    required: true
---

You are helping integrate AcmeAuth for a {{app_type}}.
Use {{auth_method}} as the primary authentication method.
Include authentication, rate-limiting, and webhook setup guidance.
```

## Format: `*.template.yaml` (Structured)

Use this when you need multiple messages or more explicit structure.

```yaml
title: Webhook Delivery Debug Playbook
description: Triage and resolve failed webhook deliveries.
arguments:
  - name: event_type
    required: true
  - name: status_code
    required: true
  - name: retry_attempt
messages:
  - role: user
    content:
      type: text
      text: |
        Investigate a failing webhook delivery for event {{event_type}}.
        The endpoint returned HTTP {{status_code}} on retry {{retry_attempt}}.
  - role: user
    content:
      type: text
      text: |
        Provide likely root causes, remediation steps,
        signature verification checks, and a retry checklist.
```

## Argument Schema

Arguments are validated with a simple schema:

- `name` (required)
- `title` (optional)
- `description` (optional)
- `required` (optional, boolean)

## Authoring Guidelines

- Prefer `.template.md` for concise single-workflow prompts.
- Use `.template.yaml` for multi-step or multi-message flows.
- Keep argument names stable and descriptive.
- Mark only truly required arguments as `required: true`.
- Write prompt text so it can stand alone without hidden assumptions.
