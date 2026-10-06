# Chrome identities and isolated AGY accounts

`/account` selects the Google account for **new** AGY jobs. Active jobs retain
their captured account home. OpenCode and Cursor account selection is unchanged.

Chrome login is not an AGY login. Import only identity metadata, never Chrome
cookies, OAuth tokens, passwords or another account's CLI files. The official
[AGY sign-in flow](https://www.antigravity.google/docs/cli/install/) establishes
each account's own session and retains any browser consent or verification step.

## Import identities on the MacBook

From this repository:

```bash
node scripts/agy-chrome-accounts.mjs import
```

The importer reads `profile.info_cache[*].user_name` in Chrome's `Local State`.
Additional accounts signed in on Google websites do not necessarily have their
own Chrome profile. After reading their identities from the live Google account
chooser through the configured browser transport, put those **email addresses
only** in a private file outside Git:

```json
[{ "email": "alex@example.com" }]
```

Then merge the two identity sources:

```bash
node scripts/agy-chrome-accounts.mjs import --inventory /private/path/accounts.json
```

The importer deduplicates email identities, creates stable `google-*` aliases
under `~/.local/share/telegram-agent/accounts`, and creates an empty isolated
`home` plus `account.json` for each identity. Directories are mode `0700`, files
`0600`. Existing mismatched metadata is rejected, not overwritten. Importing is
idempotent and does not authenticate, select an account, call a model or start
another Telegram poller. `AGY_ACCOUNTS_DIR` or `--accounts-dir` overrides the root.
An inventory exported from the MacBook can create the same identity aliases on
Arch, but AGY login must happen independently on that host; no tokens move hosts.

## Sign in and select

Look up the alias in the private account directory, then run:

```bash
node scripts/agy-chrome-accounts.mjs login google-ALIAS --agy /absolute/path/to/agy
```

Use the actual generated alias, not the placeholder. The helper launches the
official CLI with that profile's `HOME`; choose the displayed expected Google
identity in the browser. It removes a model API key from that subprocess's
environment and does not touch the default account's credentials. Do not run
`/logout` in the default profile to configure another account.

The login helper temporarily installs a
[native AGY status-line command](https://www.antigravity.google/docs/cli/statusline/)
that checks the authenticated `email` against the imported identity. It stores
only that identity and credential-file metadata, never credential contents. On
normal exit or cancellation with Ctrl-C/SIGTERM it restores the previous
status-line configuration while preserving other
settings changed by onboarding. A forced kill or system crash cannot run cleanup;
restore the profile's previous status-line setting manually before retrying.
A wrong-account login stays unavailable. This is a local consistency check, not
a security boundary against processes that can edit the same private profile.

Imported profiles remain visible in `/account` with a sign-in-required label
until this identity check matches their current independent credential file.
Replacing credentials invalidates that verification. Selecting a pending profile
leaves the previous account selected. This does not assert current token validity
or available model quota; the real AGY model/job call still validates the session
and selected model. Expiry, missing access and exhausted quota must
fail explicitly, never switch account/model or replay a job automatically.

Private identity inventories, profiles and sessions remain outside the repository.
A tested source change or import does not constitute runtime acceptance. Deploy
only after a reviewed live acceptance and explicit approval, without replacing
another task's service or running a duplicate poller.
