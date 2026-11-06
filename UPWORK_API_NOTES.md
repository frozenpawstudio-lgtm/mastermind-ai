# AIRA Upwork connector — source notes

These are planning/implementation notes from Upwork's official developer materials, read on 2026-11-04. No Upwork account, API, or credentials were accessed during research.

## Official endpoints and access requirements

- GraphQL API: `https://api.upwork.com/graphql`
- OAuth 2.0 authorization: `https://www.upwork.com/ab/account-security/oauth2/authorize`
- OAuth 2.0 token and refresh: `https://www.upwork.com/api/v3/oauth2/token`
- Upwork API docs state OAuth 2.0 is required for API requests, and an application must obtain a `client_id` and client shared secret through the Upwork API Center.
- Upwork docs list `publicMarketplaceJobPostingsSearch` for public marketplace job postings and the permission `Read public marketplace Job Postings`. The documentation also says `Common Entities - Read-Only Access` is required generally. Exact permissions granted to a real app must be checked in Upwork's API Center; the connector must not assume approval.
- The GraphQL filter `PublicMarketplaceJobPostingsSearchFilter` documents `searchExpression_eq` (partial Lucene syntax), `daysPosted_eq`, and `pagination`. The result type documents job identifiers, title, description, `ciphertext`, posted time, contract type, budget, skills, category, status, total applicants, and a flag indicating whether freelancer location is mandatory. That flag does not establish India eligibility.
- Access tokens are documented as expiring after 24 hours; refresh tokens expire after two weeks since last use. A refresh response can return a replacement refresh token; if implemented, it must be stored securely and atomically.
- Upwork's API documentation says response data must not be cached/stored for more than 24 hours. AIRA's Upwork search design therefore must not persist listing results in its opportunity database, KV, R2, browser storage, or logs; show results transiently with `Cache-Control: no-store` and retain source links only in the current page state.
- This integration is read-only. It must not submit proposals, send messages, buy Connects, accept contracts, or perform financial actions. The V9 Owner must manually review and submit on Upwork.

## Official references

1. Upwork GraphQL API documentation: https://www.upwork.com/developer/documentation/graphql/api/docs/index.html
2. Upwork Developer Space / API key process: https://www.upwork.com/developer
3. Upwork official AI/MCP capabilities (informational; not used by this Worker integration): https://www.upwork.com/ai/mcp

## Current AIRA decision

The Owner chose Upwork as the only earning source. RemoteOK and Fiverr are out of this connector's scope. Source code is prepared locally, but the feature must remain disabled until the Owner supplies approved Upwork OAuth app credentials and separately authorizes production configuration/deployment. Search results remain transient and `UNVERIFIED`; India eligibility stays `UNKNOWN` until verified from the official listing.


## Local implementation status (2026-11-05)

This repair worktree now includes the disabled-by-default connector. The public status endpoint is sanitized; OAuth start, callback processing and search are protected by the Owner boundary and use one-time hashed state plus PKCE. OAuth tokens and the verifier are AES-GCM encrypted before storage in the existing Durable Object SQLite database. Searches are explicit Owner actions, rate-limited, capped at ten results, and returned with no-store headers; result listings are not persisted in AIRA tracking or app logs. Upwork submission, messaging, buying Connects and financial actions are not implemented.

No Upwork-related variable is set in this worktree (`.dev.vars` contains only the local Owner test credential). Only offline mocked tests and the local static-asset exposure regression were run; no Upwork account or API endpoint was called, and no Cloudflare secret, production Worker, or remote Git branch was accessed/changed. Production Cloudflare secrets were not inspected. A real connection still requires Owner-approved Upwork app credentials and read-only public-job permission, followed by separate authorization for production secret configuration and deployment.
