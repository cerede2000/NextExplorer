# Test plan — API tokens

This plan exists because a token is a credential. Everything else in this
application can be checked by looking at it; a credential has to be checked by
trying to misuse it, which is what most of this page does.

Run it against a real installation, signed in as an administrator, with a
second, non-administrator account to hand. `HOST` below is your server —
`http://192.168.1.250:3017`, say.

Automated coverage for all of this lives in
`backend/tests/services/api-tokens.test.js`,
`backend/tests/routes/api-tokens.test.js`,
`backend/tests/security/api-token-access.test.js` and
`backend/tests/security/api-token-pentest.test.js`. This page is what to do by
hand before believing them.

## 1. Issuing one

1. **Settings → API tokens.** The page says there are none.
2. Fill in a name, leave the scope on **Read only**, leave the expiry on
   **Until it is revoked**, type your password, press **Issue token**.
3. The value appears once, in a box that says so, with the header to send it as
   and a **Copy** button. **Copy it now** — you are about to need it, and
   nothing will show it again.
4. Reload the page. The token is listed by name, with its scope, when it was
   issued, and "never used". **The value is nowhere on the page.**

Then, the refusals:

- Press **Issue token** with the wrong password → refused, and no token is
  added.
- Issue fifty tokens (or trust `backend/tests/services/api-tokens.test.js`) →
  the fifty-first is refused with a message naming the cap.

## 2. Using one

```sh
TOKEN='nxe_…'          # the value you copied
curl -s -H "Authorization: Bearer $TOKEN" $HOST/api/volumes
curl -s -H "Authorization: Bearer $TOKEN" $HOST/api/auth/me
```

Both answer. The second names the account the token belongs to.

Now everything it must refuse. Each of these answers `403`:

```sh
# Read-only: anything that changes something
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE \
  -H "Authorization: Bearer $TOKEN" $HOST/api/files

# The account, whatever the scope
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" $HOST/api/auth/tokens
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" $HOST/api/auth/tokens

# Administration, even when the account is an administrator
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" $HOST/api/users
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" $HOST/api/settings

# A shell
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" $HOST/api/terminal/session
```

And the spellings that used to walk around a door. Express routes without
regard to case, so each of these reaches the same handler — and each must be
refused:

```sh
for path in /api/auth/tokens /API/AUTH/tokens /api/Auth/Tokens /api/auth/tokens/; do
  printf '%s ' "$path"
  curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$HOST$path"
done
```

Four times `403`. While you are there, check the gate in front of them, which
is the same class of mistake one layer up — with **no** credential at all:

```sh
for path in /api/volumes /API/volumes /Api/Volumes; do
  printf '%s ' "$path"
  curl -s -o /dev/null -w '%{http_code}\n' "$HOST$path"
done
```

Three times `401`. Before this release, the second and third answered `200`.

## 3. A token that writes

Issue a second token with **Read and write**. It uploads, renames and deletes
as its owner does — and it is refused at exactly the same doors as the first:
the account, administration, the terminal. The scope widens what it may do with
files and nothing else.

## 4. Revoking one

1. Revoke the read-only token from the settings page; confirm.
2. The same `curl` that worked a minute ago now answers `401`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $HOST/api/volumes
```

3. Turn the **activity log** on (Settings → Activity log) and present the
   revoked token three or four more times. The log shows **one** line — a
   refused sign-in, naming the token — and not one per attempt. Presenting it
   for an hour would still show one.

## 5. What a stolen database would give

On the server:

```sh
sqlite3 /config/app.db 'SELECT id, name, scope, secret_hash FROM api_tokens;'
```

`secret_hash` is a SHA-256; the value you copied appears nowhere. Try to use
the hash as a token — it is refused, like anything else that is not the value.

A revoked token's row keeps its name and the date it was revoked, and its hash
reads `revoked`: nothing in it can authenticate anything again.

## 6. It is never more than its account

- Sign in as the other account and ask for the first account's tokens: the list
  is empty, and revoking one by its identifier answers `404`.
- Take the admin role off an account that holds a token: its token loses
  administration on the next request, without being touched.
- Delete the account: its tokens go with it — `SELECT COUNT(*) FROM api_tokens`
  for that account answers `0`.

## 7. Two-factor and identity providers

- An account with a second factor issues tokens normally, and its tokens do not
  ask for a code: a token **is** the credential. That is the point of being able
  to revoke it on its own.
- An account that signs in through an identity provider issues tokens too, and
  is not asked for a password it does not have.
