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

## The editing server is not a reader

ONLYOFFICE and Collabora fetch the document and report back to it themselves,
from wherever they run. They carry a token this application signed and no account
at all, so an authentication proxy has nothing to let them through on.

For a document **inside a share** the address they are given is under
`/api/share/<token>/…`, so the hole above already covers it. For every other
document it is `/api/onlyoffice/file` and `/api/onlyoffice/callback`, which are
the whole instance's and must not be opened in the proxy.

Point the editing server at the application directly instead:

```
EDITOR_INTERNAL_URL=http://nextexplorer:3000
```

That is the address ONLYOFFICE or Collabora can reach this application at on the
network they share — a container name, a LAN address — and it is only used for
the addresses handed to them. Everything a person sees still uses `PUBLIC_URL`.
Unset, it is `PUBLIC_URL`, and an editing server outside the proxy cannot save.

## Everything, not just the bytes of a file

What a visitor can do in a share is more than reading it, and all of it is under
the prefix:

- the listing, a subfolder, a thumbnail, a file in the viewer, a file in the
  editor, a download, and what is inside an archive;
- uploading into a share that accepts them, including the resumable kind: the
  server keeps the prefix in the address it tells a client to continue at;
- copying, moving and extracting — the dialogs that walk folders to ask where,
  which also cannot be sent above the share;
- searching inside the share, from the box at the top or with `Ctrl+K`;
- a file's earlier versions, where the share's owner turned that on — listed,
  read, downloaded, put back, compared side by side with the file as it is now,
  and the same history inside ONLYOFFICE;
- the name and the logo the page draws itself with, which is why a chosen logo
  is served under the prefix as well instead of at `/static/logos/…`.

A share that shows no histories offers none: the mark in the listing, the entry
in the menu and the editor's own History are not drawn rather than drawn and
refused. And a visitor is never asked for the mode, owner or group of a file —
that is `/api/permissions/…`, which is the whole instance's and stays behind the
proxy.

A browser journey walks a visitor through a whole share with every other address
refused, and fails if anything is asked outside these three. A second one checks
the other direction: every address the browser builds under a share's prefix is
compared against the routes the server mounts there, so an endpoint that is asked
for and answered by nothing fails the build rather than the reader.

The one request that may be refused is `/api/auth/status`, which cannot be
answered to somebody the proxy has not let in — and "nobody is signed in" is the
honest answer for them, which is what the page falls back to without saying
anything.
