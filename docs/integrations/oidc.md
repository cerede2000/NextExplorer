# OIDC Integration

nextExplorer uses Express OpenID Connect (EOC) to federate authentication with external providers. Configure these variables and your IdP once, and the app exposes `/login`, `/callback`, and `/logout` to manage the flow.

## Environment variables (see `backend/src/config/env.js`)

- `OIDC_ENABLED=true` enables the middleware.
- `OIDC_ISSUER` points to the IdP discovery URL (e.g., Keycloak realm or Authentik application base).
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` store client credentials.
- `OIDC_SCOPES` defaults to `openid profile email`; add `groups` if you want nextExplorer to inspect group claims.
- `OIDC_ADMIN_GROUPS` contains comma/space-separated group names that grant the admin role when present in `groups`, `roles`, or `entitlements` claims.
- `OIDC_REQUIRE_EMAIL_VERIFIED` (default `false`) — when `true`, requires the IdP to verify the user's email before allowing user creation or auto-linking. Some providers like newer versions of Authentik set `email_verified` to `false` by default; keep this setting as `false` to allow those users to log in. Whatever it is set to, an address the IdP has **not** verified never attaches a sign-in to an account that already exists here: that would let whoever controls an unverified address at the IdP sign in as the account holding it. Such a sign-in gets an account of its own; to reach an existing one, have the IdP mark the address verified. Only a boolean `true` counts — the string `"false"` is not verified.
- `OIDC_AUTO_CREATE_USERS` (default `true`) — when `false`, the user must already exist in the nextExplorer database (local or previously OIDC-linked), otherwise OIDC login is denied.
- `OIDC_MOBILE_REDIRECT_URIS` — optional comma-separated allowlist of native-app custom-scheme callbacks for the mobile bridge. The default is `nextexplorer://oidc-callback`; HTTP(S) URLs are deliberately rejected.
- Optional overrides: `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL`, `OIDC_USERINFO_URL`, `OIDC_LOGOUT_URL`, and an explicit `OIDC_CALLBACK_URL` (defaults to `${PUBLIC_URL}/callback`).
  - `OIDC_LOGOUT_URL` — optional custom IdP logout URL. When set, logout requests redirect to this URL with a `post_logout_redirect_uri` parameter (OIDC standard). If not set, logout only clears the local session without redirecting to the IdP. A `returnTo` given to `/logout` is honoured only as a path on this site; anything else ends on the sign-in page.

## Choosing authentication modes

Use `AUTH_MODE` to control which authentication methods are available:

- `AUTH_MODE=oidc` — **OIDC only**: The login page shows only the "Continue with Single Sign-On" button. Users cannot create local passwords.
- `AUTH_MODE=local` — **Local only**: The login page shows only username/password fields. OIDC is disabled even if `OIDC_ENABLED=true`.
- `AUTH_MODE=both` — **Dual authentication** (default): Users can choose between local login or SSO. The login page displays both options.
- `AUTH_MODE=disabled` — **No authentication**: Skips the login page entirely and makes all APIs public (same as `AUTH_ENABLED=false`).

## Flow overview

1. A user clicks “Continue with Single Sign-On” on the login page.
2. The app redirects to `${OIDC_AUTHORIZATION_URL}` or the issuer discovery endpoint.
3. After IdP authentication, the callback (`/callback`) is invoked, sessions are established, and the user lands back in the workspace.
4. Logout routes (`/logout`) tear down the session. If `OIDC_LOGOUT_URL` is configured, logout redirects to the IdP logout endpoint with a `post_logout_redirect_uri` parameter to complete the IdP logout flow. Otherwise, only the local session is cleared.

## Admin elevation

- nextExplorer inspects the `groups`, `roles`, and `entitlements` claims returned by the IdP.
- If any entry matches `OIDC_ADMIN_GROUPS` (case-insensitive), the user is promoted to admin.
- Without a match, the user receives the standard `user` role and only sees non-admin settings.

**This is re-evaluated at every sign-in**, so removing someone from the admin
group at the IdP takes their admin rights away here the next time they log in,
and adding them grants it. Role changes are written to the log.

Two conditions have to hold before the IdP is allowed to decide, and both exist
to stop a misconfiguration from locking everyone out:

- **`OIDC_ADMIN_GROUPS` must be configured.** Without it every login would
  derive the plain `user` role, and applying that would strip the rights of
  anyone promoted from the interface — the bootstrap account included.
- **The IdP must actually return a group claim.** A missing `groups` scope looks
  exactly like a user who belongs to no group; roles are left untouched rather
  than reset on that silence.

Where neither holds, roles stay as they are and are managed from **Settings →
Users** instead. If you do lock yourself out, setting `AUTH_ADMIN_EMAIL` to your
address and `AUTH_ADMIN_PASSWORD`, with `AUTH_MODE` at `local` or `both`, and
restarting restores the admin role on that account.

**Who signs in is the person the id token names.** The claims are read from the
id token the library verified; a userinfo answer about a different subject
refuses the sign-in, and when userinfo or the discovery document is briefly
unavailable, the sign-in goes ahead on the id token alone.

## Native iOS & Android clients

The mobile bridge lets a native client use the device’s system browser (such as `ASWebAuthenticationSession` on iOS or Custom Tabs on Android) while keeping the authorization result bound to the app with PKCE.

1. Generate a PKCE verifier and its `S256` challenge in the app.
2. Open `GET /api/auth/oidc/mobile/login` in the system browser with `code_challenge`, `code_challenge_method=S256`, and an allowlisted `redirect_uri`.
3. After the IdP completes sign-in, nextExplorer redirects to that custom-scheme URI with a short-lived, single-use `code`.
4. Send the `code` and original `code_verifier` to `POST /api/auth/oidc/exchange` to establish the normal nextExplorer session.

Only custom-scheme URIs listed in `OIDC_MOBILE_REDIRECT_URIS` can receive the code. Do not use an embedded web view, reuse an authorization code, or send the PKCE verifier through the redirect URI.

## Common troubleshooting

- **Invalid redirect URI**: Ensure your IdP’s redirect URI matches `${PUBLIC_URL}/callback` or the explicitly configured `OIDC_CALLBACK_URL`.
- **Sessions drop after restart**: Supply a stable `SESSION_SECRET` instead of letting the app generate one dynamically.
- **Not an admin after login**: Verify the IdP includes the expected group claim (e.g., `groups` scope) and that `OIDC_ADMIN_GROUPS` contains the group name exactly. Both are required before the IdP may set roles at all — without them the role stored on the account is kept, whatever the claims say.
- **"Email must be verified before linking an existing account"**: the IdP reported the address as unverified and an account here already holds it. Have the IdP mark it verified (in Authentik, map `email_verified` to `true`), then sign in again.
- **Cookies flagged Insecure**: Run the app over HTTPS (`PUBLIC_URL` must use `https`) and confirm your proxy forwards `X-Forwarded-Proto`/`Host` headers (see the Reverse Proxy guide).
- **Mobile callback rejected**: Add the app’s exact custom-scheme URI to `OIDC_MOBILE_REDIRECT_URIS`, and ensure the request uses an `S256` PKCE challenge.
