# Authenticate with an access token, never a stored password

Commands read an access token from `SUPERNOTE_TOKEN` and never take a password; only `login` asks for one, and it prints the token instead of saving it. Two things forced this. Login can stop for identity verification, which needs a human, so a stored password could not make runs fully automatic anyway. And secret stores that keep the real value outside the process, such as Docker Sandboxes' proxy, substitute a placeholder in outgoing requests: a token travels untouched in the `x-access-token` header and gets swapped, but a password is hashed with a server-issued random code before it is sent, so a placeholder password can never become the real one.

## Considered Options

- **Email and password from the secret store, login on every run**: rejected for both reasons above.
- **Resolve `op://` references by calling the 1Password CLI**: dropped once the token lives in an environment variable, since `op run` and `sbx secret set-custom --command 'op read …'` already cover 1Password without the tool knowing about it.

## Consequences

The tool cannot tell an expired token from a placeholder until the server rejects it, so it never checks expiry itself; it reports the rejection and tells the user to log in again.
