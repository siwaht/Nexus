---
name: Replit preview proxy breaks OIDC redirect URIs
description: Behind the Replit preview proxy the request Host is localhost, so OIDC callbacks built from the Host header get rejected as "Invalid authentication request".
---

Requests arriving through the Replit preview proxy carry `Host: localhost` (and possibly no usable `x-forwarded-host`). Building an OIDC `redirect_uri` from that host produces `https://localhost/api/callback`, which the repl's OIDC client rejects with an "Invalid authentication request" page.

**Why:** Replit OIDC only accepts redirect URIs on the repl's registered public domains. localhost is never registered.

**How to apply:** When constructing absolute callback/origin URLs server-side, detect a localhost/127.0.0.1 host and substitute `https://${REPLIT_DEV_DOMAIN}` instead. Also split comma-separated `x-forwarded-host` proxy chains and take the first hop. Direct public traffic (custom/deployed domains) arrives with a real Host and should be used as-is. Implemented in `getOrigin` in the API server's auth routes.
