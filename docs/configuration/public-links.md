# Public links behind an authentication proxy

A share link is meant for somebody who has no account here. If this instance sits
behind an authentication proxy — Authelia, Authentik, oauth2-proxy, Cloudflare
Access — that proxy answers before the application does, and a visitor following a
public link is asked to sign in to something they have never heard of.

The proxy therefore needs a hole, and a hole is a list of paths. Everything a
visitor's browser asks for is under three of them:

| Prefix        | What it carries                                                             |
| ------------- | --------------------------------------------------------------------------- |
| `/share/`     | Every page a visitor sees: the door, the listing, the viewer, the editor    |
| `/api/share/` | Every request made on their behalf, from the listing to the bytes of a file |
| `/assets/`    | The build's own files: the scripts, the stylesheet, the icons               |

Nothing else. In particular `/api/download`, `/api/preview` and `/api/thumbnails`
are **not** on the list and must not be added: those are the whole instance's, and
opening them in front of the proxy would open every file in it. A visitor reaches
the same handlers under `/api/share/<token>/…`, where the server checks that the
visitor holds a session for that share before anything else looks at the request.

## Traefik

```yaml
labels:
  traefik.http.routers.nextexplorer-public.rule: >-
    Host(`files.example.com`) &&
    (PathPrefix(`/share/`) || PathPrefix(`/api/share/`) || PathPrefix(`/assets/`))
  traefik.http.routers.nextexplorer-public.priority: '100'
  traefik.http.routers.nextexplorer-public.service: nextexplorer
  # and no forward-auth middleware on this router
```

`PathPrefix` is anchored at the start of the path, so `/share/` matches
`/share/<token>/browse/…` and nothing else; the signed-in application lives under
`/browse/`, `/open/` and `/editor/` and stays behind the proxy.

## Caddy

```caddyfile
files.example.com {
  @public path /share/* /api/share/* /assets/*
  handle @public {
    reverse_proxy nextexplorer:3000
  }
  handle {
    forward_auth authelia:9091 { uri /api/verify?rd=https://auth.example.com }
    reverse_proxy nextexplorer:3000
  }
}
```

## NGINX

```nginx
location ~ ^/(share|api/share|assets)/ {
  proxy_pass http://nextexplorer:3000;
}
```

## What is still outside

Uploading into a share that accepts uploads goes to `/api/upload`, which is the
instance's own upload endpoint: a resumable upload is told where to send the rest
of itself by the answer to its first request, and that address is built inside the
upload server. A share published read-only — which is what a public link usually
is — never touches it.
