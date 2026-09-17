# Reverse Proxy & Networking

When exposing nextExplorer on a custom domain, a reverse proxy keeps the UI secure behind TLS while forwarding requests to the container. Use this guide to align `PUBLIC_URL`, trusted proxies, and CORS behavior.

## Key environment variables

| Variable                             | Purpose                                                                                                                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                         | External URL (no trailing slash) used to set cookies, determine OIDC callbacks, and drive CORS defaults. Example: `https://files.example.com`.                                                                                            |
| `INTERNAL_URL`                       | Optional comma-separated LAN origins. They are accepted by CORS and can each complete OIDC login without redirecting through `PUBLIC_URL`.                                                                                                |
| `TRUST_PROXY`                        | Controls Express’s trust level; accepts `false`, a number (hops), or lists such as `loopback,uniquelocal`. If unset and `PUBLIC_URL` exists, defaults to `loopback,uniquelocal`. (`backend/config/trustProxy.js` documents this mapping.) |
| `CORS_ORIGIN(S)` / `ALLOWED_ORIGINS` | Explicit CORS origins when they differ from `PUBLIC_URL`. Defaults to the origin of `PUBLIC_URL` when provided.                                                                                                                           |

## Sample Nginx Proxy Manager block

- Point `files.example.com` to the container’s internal `3000` port.
- Enable WebSockets and preserve `X-Forwarded-*` headers (usually automatic).
- Terminate TLS at the proxy; nextExplorer marks cookies as `Secure` whenever `PUBLIC_URL` uses `https`.

## Trusted Proxy notes

- Default when `PUBLIC_URL` is set: `loopback,uniquelocal`, which trusts local or private Docker networks without opening up to the public internet.
- Override with values such as `1` (trust one hop) or CIDRs (`10.0.0.0/8,172.16.0.0/12`).
- Avoid `TRUST_PROXY=true` alone; the entrypoint maps it to `loopback,uniquelocal` for safety.

## The address that gets recorded

The activity log, share access counters and the server's own warnings all
write down one address per request, and which one that is depends entirely on
this page.

- **No proxy.** Whoever opened the socket. In a container that is often not the
  person: a connection made from the Docker host itself, or relayed by Docker's
  userland proxy — which is every connection on Docker Desktop — arrives from
  the bridge (`172.17.0.1`, `172.18.0.1`). From another machine on the LAN to a
  published port on Linux, the real address survives. Nothing in the
  application can recover an address the kernel already replaced; that is a
  Docker networking matter, not a setting here.
- **Behind a proxy.** `TRUST_PROXY` decides whether the address the proxy
  announces is believed. `loopback` alone is not enough when the proxy is
  another container: it speaks from the bridge network, so use
  `loopback,uniquelocal` or the proxy's own CIDR.
- **A chain is read from the right**, and stops at the first hop that is not
  trusted — a hop nobody vouches for could have written everything to its left.
  Trust one proxy and three appear in the chain, and what you get is the third
  one, not the person.
- **`CF-Connecting-IP` wins where Cloudflare is in front**, then
  `X-Forwarded-For`, then `X-Real-IP` (nginx's own example configuration sends
  that one and not the first). `True-Client-IP` is read as well.
- **A Cloudflare tunnel only helps when it carries HTTP.** A public hostname
  route goes through Cloudflare's edge, which adds `CF-Connecting-IP`, so the
  person is named. A private network route — reaching the machine through WARP
  by its own address and port — forwards raw TCP: there is no HTTP for a header
  to be added to, the origin sees `cloudflared` itself, and nothing on this
  page recovers an address that never arrived.
- **Never trust a proxy that is not yours.** With `TRUST_PROXY` set, anybody who
  can reach the port directly can choose what the log says about them.

When a proxy announces a client and nothing here believes it, the server says
so once in its own log, naming the address it was told and the one it is
recording instead — the alternative is a log where every line says
`172.18.0.1` and nothing anywhere says why.

To settle it from a browser rather than from the logs, an administrator can
open `/api/activity/address`. It answers with the address that would be
recorded, the machine at the other end of the socket, whether that machine is
believed, the rule in force — which is also how to see that `TRUST_PROXY` never
reached the process — and every forwarding header that arrived. An empty list
of headers is the answer to the hardest version of the question: nobody
announced a client, so there is nothing to believe.

## CORS & headers

- Set `CORS_ORIGINS`/`ALLOWED_ORIGINS` when the app is accessed from multiple domains.
- For a full walkthrough (including `PUBLIC_URL` and origin mismatch behavior), see [Fixing CORS errors](/reference/cors).
- Ensure the proxy forwards `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-For` so the backend derives the correct `PUBLIC_URL` origin and TLS state.

## Networking health checklist

- Proxy has TLS termination and forwards headers. Without headers, session cookies may appear as `Insecure`.
- POST, PUT, DELETE operations work through the proxy; test with uploads and metadata edits.
- If using OIDC with `INTERNAL_URL`, register `${PUBLIC_URL}/callback` and every `<INTERNAL_URL>/callback` with the IdP. The browser returns to the exact configured origin where login started.

## Troubleshooting proxies

| Symptom                                  | Fix                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORS errors                              | Add the proxy domain to `CORS_ORIGINS` or set `PUBLIC_URL`.                                                                                                                            |
| Sessions drop                            | Confirm `TRUST_PROXY` lets Express read `X-Forwarded-Proto` and `COOKIE` is not stripped.                                                                                              |
| Redirect URI mismatch (OIDC)             | Register `${PUBLIC_URL}/callback` and each configured internal `<origin>/callback` with the IdP.                                                                                       |
| Every logged address is the same `172.x` | The proxy is not trusted, or there is no proxy and Docker replaced the source. Set `TRUST_PROXY=loopback,uniquelocal`; the server warns once when it is ignoring an announced address. |
