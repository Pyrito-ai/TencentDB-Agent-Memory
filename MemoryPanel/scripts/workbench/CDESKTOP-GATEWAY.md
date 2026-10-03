# Authenticated cdesktop browser gateway

The Panel can serve cdesktop's compiled interface and HTTP/WebSocket traffic on a separate HTTPS origin. The browser contacts the gateway, not localhost. The process, worktrees, and provider subscriptions remain on the owner's machine.

## Trust boundary

This is **owner-only access to the entire native runtime**, not task/workspace isolation. Native cdesktop includes global sessions, files, terminals, and configuration. Configure one existing instance/user owner; team membership or administrator role alone does not grant access.

The Panel authenticates the owner and checks active membership, task ownership, saved handoff, current binding, profile, context, package, and live receipt. It issues a one-use 60-second ticket, posted in a form body to the runtime origin, never URLs or browser storage. An opaque `__Host-pyrito-runtime` Secure/HttpOnly/SameSite=Strict cookie identifies the session. Authorization is rechecked within 15 seconds, including live sockets. Sessions expire after 15 minutes without HTTP/upgrade activity or one hour maximum. Reconnect obtains a fresh grant. Logout revokes access; restarting the Hub invalidates all sessions.

Use sibling HTTPS hosts under the same site, such as `app.pyrito.com` and `cdesktop.pyrito.com`. This allows Strict iframe cookies without sharing the app origin or widening cookie Domain. Do not use the app origin or browser-local addresses for the gateway.

## Setup

1. Build cdesktop `packages/local-web` from a reviewed revision. Serve its compiled `dist`:

   ```sh
   node MemoryPanel/scripts/workbench/cdesktop-browser-server.mjs \
     --static-dir /absolute/path/to/cdesktop/packages/local-web/dist \
     --port 5192 --backend http://127.0.0.1:8131
   ```

   This binds only `127.0.0.1`, refuses source maps/private files/symlinks, and forwards API/WS to a fixed loopback backend. It retains cdesktop's existing upstream Host/Origin `http://127.0.0.1:5190`.

2. Run a separate outbound reverse Unix-socket tunnel using `ssh-runtime-tunnel.py`. Its private JSON config supplies `key`, `knownHosts`, `host`, `socketPath`, and `localPort: 5192`. Preserve the handoff bridge tunnel. Mount the socket directory into the Hub; do not publish native TCP ports or loosen socket permissions.

3. Set `CDESKTOP_GATEWAY_CONFIG` to a private JSON file visible to the Hub:

   ```json
   {
     "origin": "https://cdesktop.pyrito.com",
     "appOrigins": ["https://app.pyrito.com"],
     "socketPath": "/data/knowledge/workbench/cdesktop-web.sock",
     "upstreamOrigin": "http://127.0.0.1:5190",
     "ownerInstanceId": "existing-instance",
     "ownerUserId": "existing-runtime-owner",
     "port": 8126,
     "bindHost": "0.0.0.0"
   }
   ```

   Unset disables the gateway. A present invalid config stops startup. `0.0.0.0` is for the private Docker network only; never publish its port. The second listener shares auth state with the Panel.

4. Route only the exact runtime hostname through the existing TLS proxy to the private Hub port. Preserve Host; do not rewrite Origin. Keep all existing app/callback routes and protections.

5. Verify unauthorized denial, correct owner access to an existing saved session, HTTPS HTTP/WebSocket transport, and logout revocation. Test with browser local-device access blocked. Navigation and verification do not need to launch workers.

## Current limits

Development-server previews are blocked (`/api/preview` and nested-frame CSP). They need a separate authenticated preview origin before untrusted project HTML can safely be exposed. Active-content attachments download instead of executing within the runtime origin. The local machine must remain awake with backend and tunnel available. Reconnect after expiry, logout, Hub restart, or transport recovery. This does not migrate sessions or add multi-user runtime isolation.

## Recovery

Disable the exact runtime proxy route to close access immediately. Remove the gateway config environment variable and roll back only the Hub image/config to the pre-release snapshot. Stop only the new UI server and UI tunnel jobs. Preserve the handoff tunnel, native backend/workspaces, app routes, Core, Proxy, ClickHouse, and current databases. Never restore an old database as part of code rollback.
