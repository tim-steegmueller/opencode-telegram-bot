# OpenCode V2 and AGY catalog repair

The original checkout at `/home/tim/dev/opencode-telegram-bot` contains concurrent work and is not modified by this repair. The repair snapshot contained that source state; its full dirty diff was not a deployable patch. The notes below record that isolated repair, not deployment of the merged main source.

## Reused upstream implementation

The V2 adapter (`src/opencode/v2/{client,events,mappers}.ts`), its three test modules, and `src/utils/type-guards.ts` are copied unchanged from `grinev/opencode-telegram-bot` release `v0.26.3`, commit `cd121214fcad1ed3d3484fdfe38766f50b197fa2`. The original MIT license applies. Only the existing client factory and configuration gain the explicit `OPENCODE_SERVER_VERSION=v2` branch. No automatic server detection, model fallback, or replacement server is introduced.

The source build uses SDK `1.18.8` for the adapter's current types and client `2.0.23`. At runtime, the copied adapter only imports the V2 client. Targeted Mac deployment retains the installed V1 SDK and unrelated dependencies. The dependency installation failed when compiling the old SQLite module with Node 26; V2 dependencies are therefore installed in an isolated directory with scripts disabled. No database migration or SQLite dependency replacement is deployed.

## Deployment boundary

The private deployment manifest is `/home/tim/.local/state/agent-handoffs/chatgptelegram/agy-refresh-20261006/mac-patch-manifest.json`. Its baseline is a fresh snapshot of the installed Mac package, not this entire working tree. The AST-based patch retains the installed `hasRecoveredAgyJob` export and the Mac prompt handler, avoiding the concurrent Arch queue implementation.

AGY menus and model resolution read `agy models` from the selected account. Current unsupported selections fail explicitly instead of silently running a different model. Raw shell commands and tool-error log excerpts are not forwarded as progress, and agent failures do not expose stderr or stack traces in Telegram. `/new` can leave idle inline/model-search states, but does not bypass active work, permissions, or questions.

The native Mac catalog currently exposes 14 AGY models, including `gemini-3.8-flash-high`; the Arch account exposes a different catalog. Existing selected engine/model settings are preserved. Muse Contributor Free is listed, not selected automatically, because its provider permits training on submitted content.

## Complete OpenCode catalog

The model menu keeps favorites, recent selections and search, and adds a provider browser over the native API catalog. Provider/model lists are paginated in rows of ten. The entire Go catalog is available, including DeepSeek variants, without the ten-result search limit. Short index callbacks stay within Telegram's 64-byte limit; their IDs resolve against the snapshot stored on the active menu, not a later catalog refresh. Expired or unavailable catalogs fail explicitly. No selection, provider account or model fallback is made automatically.

## Operational AGY errors

Structured `AGY_ERROR` records are classified as quota/rate limit, denied access, timeout or temporary provider unavailability. Only a bounded HTTP error code, numeric reset interval and safe error reference are added to model and elapsed-time diagnostics. Free provider error text, shell commands and stack traces remain out of Telegram notices. Recovered failures use the same formatter and do not replay the request. A listed model is not proof of remaining provider quota.


## Main integration boundary

The main integration retains the later v0.22.2 settings, document extraction,
message coalescing, permission and pinned-context changes. It includes the isolated
Chrome identity importer and pending-login account gate described in
[AGY accounts](docs/agy-accounts.md). No credential is imported from Chrome or
copied between hosts.

Direct prompts and durable preparation share an owned run lease. Aborts bind the
current run before Telegram I/O, prevent a cancelled pending worker from launching,
and stop only that run's child or captured worker unit. A failed launcher is not
proof that no worker started: its unit must be stopped before ownership is released.
Unconfirmed stops retain ownership and prevent `/start` from resetting context.

This source integration does not activate or replace the MacBook or Arch poller.
The recorded model counts are observations of the repair, not a fixed catalog or
quota guarantee. Runtime acceptance, per-host Google consent and activation remain
separate gates.
