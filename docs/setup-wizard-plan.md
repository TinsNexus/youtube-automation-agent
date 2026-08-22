# In-app setup wizard (replaces `npm run credentials:setup` / `npm run walkthrough`)

## Context

The packaged Electron app currently has no terminal for a normal user — but first-run setup (YouTube OAuth, AI provider key, video provider) only exists as two interactive CLI wizards (`utils/credential-manager.js`'s `runSetupWizard()` and `walkthrough.js`). The dashboard's `#setup-banner` today just tells the user to go run `npm run walkthrough`. The goal is a multi-step wizard **inside the dashboard UI** that covers the same configuration surface, so the desktop app is usable end-to-end without a terminal.

Scope, confirmed with the user: **single YouTube channel only** (matches the app's current architecture — `credentials.json`/`tokens.json` each hold exactly one `youtube` entry; there is no per-channel concept anywhere in the DB or pipeline). The wizard must clearly display which channel is connected. Supporting multiple channels would be a separate, much larger project (array-based credential storage, channel switcher UI, channel-scoped content/schedule/publish) and is explicitly out of scope here.

Key discovery from investigation: `YouTubeAutomationAgent.completeSetup()` — the linchpin — must exist because `index.js`'s `initialize()` currently only runs the "create agents + start scheduler" logic once at boot. Saving new credentials via HTTP while the server is already running (in `setupRequired: true` mode) does nothing by itself; something must re-run that activation logic in-process, without re-creating the DB connection, re-registering Express routes, or double-starting the cron scheduler.

Also discovered: `CredentialManager.validateAll()` (utils/credential-manager.js:540-563) requires **both** an AI provider **and** YouTube tokens before it reports "ready" — this is existing, unchanged product behavior, not something this plan alters. The wizard must be honest about that constraint rather than offering a "skip YouTube" that quietly leads to a dead end.

## Reused building blocks (do not duplicate)

- `walkthrough.js` exports `AI_PROVIDER_GUIDE` and `VIDEO_PROVIDER_GUIDE` (walkthrough.js:20-149) — per-provider `label`, `keyUrl`, `keyHint`, `instructions[]`, `models[]`, `defaultModel`, `covers`, and a `save(credentials, ...)` function that mutates the credentials object in the exact correct shape for that provider. New routes call these `save()` functions directly instead of writing new shape-handling logic (this is exactly the kind of shape drift that caused the `credentials.openai` vs `credentials.aiProvider` bug fixed earlier this session).
- `SetupWalkthrough.validateAIKey(guide, apiKey, model)` (walkthrough.js:322-347) — provider-agnostic key validation. Reused by instantiating `new (require('./walkthrough').SetupWalkthrough)()` and calling the method; `walkthrough.js` itself is not modified.
- `CredentialManager.saveCredentials()` / `saveTokens()` / `hasAITextProvider()` / `getYouTubeAuth()` / `testConnections()` (utils/credential-manager.js) — reused as-is.
- Dashboard conventions already established and must be followed, not reinvented: native `<dialog>` + `.showModal()`/`.close()` (dashboard/index.html:201-227), the shared `api()` fetch wrapper with auto `x-api-key` + 401 retry (dashboard/app.js:30-48), `showToast()` (dashboard/app.js:50-55).

## Backend changes (index.js, utils/credential-manager.js)

1. **`CredentialManager.syncEnvVars()`** (new, utils/credential-manager.js) — sets `DEFAULT_AUTHOR`, `TARGET_AUDIENCE`, `COMPETITOR_CHANNELS`, `DEFAULT_PRIVACY_STATUS` from `credentials.channel`/`credentials.content` via the existing `setEnvIfPresent()`. Bonus fix bundled here: this is currently *never* called from the server boot path (`index.js`'s `initialize()`), only from the CLI wizard's own short-lived process — meaning these env vars are silently lost on every `npm start`/app relaunch today, wizard or not. Call it from both `completeSetup()` (below) and from `initialize()`'s existing success path, right before `initializeAgents()`.

2. **`YouTubeAutomationAgent.completeSetup()`** (new, index.js) — the tail half of `initialize()`, extracted so it can run against an already-live server:
   - Guard: `if (!this.setupRequired) return { alreadyActive: true }`.
   - Re-entrancy guard: stash the in-flight promise on `this._completingSetup` and return it on concurrent calls (safe under Node's single-threaded run-to-completion — no `await` sits between the check and the assignment).
   - `await this.credentials.validateAll()` — if still false (e.g. YouTube not connected yet), throw a clear error (`error.status = 409`) rather than partially activating.
   - `this.credentials.syncEnvVars()`, `this.readiness = new ProductionReadinessService(...)`, `await this.initializeAgents()`, `await this.logCapabilitySummary()`.
   - Flip `this.setupRequired = false`.
   - Construct `this.scheduler` **only if not already set** (`if (!this.scheduler) { ... }`) and `await this.scheduler.initialize()`, then respect `automation_paused`.
   - Must **not** touch `this.db` and must **not** call `this.setupAPI()` again — both already happened once during the original `initialize()` regardless of which branch it took.

3. **New routes**, registered via a new `setupSetupWizardAPI()` method (index.js), called from the existing `setupAPI()` right after `this.setupOperatorAPI()` — matching the existing method-per-route-group convention, no new `routes/` folder (none exists elsewhere in this codebase):

   | Method & path | Auth | Purpose |
   |---|---|---|
   | `GET /api/setup/status` | none (GET, like other status routes) | `{ setupRequired, aiProviderConfigured, videoProviderConfigured, youtube: { connected, channelTitle, channelThumbnail }, ffmpegAvailable }`. If `tokens.youtube` exists, do a live `youtube.channels.list({part:'snippet', mine:true})` to populate the channel title/thumbnail for display — this is the "show which channel is connected" requirement. Never echoes back API keys/secrets. |
   | `GET /api/setup/providers` | none | Returns sanitized `AI_PROVIDER_GUIDE`/`VIDEO_PROVIDER_GUIDE` metadata (label, keyUrl, keyHint, instructions, models, defaultModel, covers/credentialName/secretName) with the `save`/`validationCreds` functions stripped out. **New addition vs. the initial draft** — the frontend must never hardcode its own copy of provider/model lists (that's exactly the kind of drift that already caused a real bug this session); it fetches this once and renders dropdowns from it. |
   | `POST /api/setup/ai-provider` | `protect` | Body `{providerId, apiKey, model}`. Looks up the guide, validates via `validateAIKey` (serialized through an `this._setupValidationInFlight` flag so two concurrent validations can't race on `validateAIKey`'s temporary `process.env` mutation), then `guide.save(this.credentials.credentials, apiKey, model)` + `saveCredentials()`. |
   | `POST /api/setup/video-provider` | `protect` | Body `{providerId, apiKey?, secret?}`. `slideshow` just sets the DB setting; other providers call `guide.save(...)` + `saveCredentials()` + `db.setSetting('video_provider', providerId)`. |
   | `POST /api/setup/youtube/credentials` | `protect` | Body `{clientId, clientSecret}`. Computes `redirectUri` **once**, from the current request (`${req.protocol}://${req.get('host')}/api/setup/youtube/callback`), saves `credentials.youtube = {client_id, client_secret, redirect_uris:[redirectUri]}`. Because the wizard's save-credentials call and its immediate follow-up oauth-url call happen back-to-back against the same running Electron/browser session, this stays internally consistent (Electron's own BrowserWindow always loads via the same fixed `HOST:PORT`). |
   | `GET /api/setup/youtube/oauth-url` | `protect` | Builds the OAuth2 client from the **stored** `credentials.youtube.redirect_uris[0]` (not re-derived), generates a random `state` nonce (CSRF protection — this callback is unauthenticated), stores `{timestamp, redirectUri}` keyed by `state` in an in-memory `this._oauthStates` Map (10-minute TTL, deleted on use), returns `{url}` including the 4 YouTube scopes already used by `modern-auth.js`. |
   | `GET /api/setup/youtube/callback` | none (Google's redirect can't carry our header — same risk profile as other unauthenticated GET routes; the `code` is one-time-use and scoped to credentials already on this machine) | Validates `state` against `this._oauthStates` (400 on missing/expired/reused), exchanges `code` via `oauth2Client.getToken()` using the state-recorded `redirectUri`, saves `tokens.youtube`, responds with a small self-contained HTML "✅ YouTube connected — you can close this window" page. Any interpolated value (e.g. `error` from Google) goes through a small server-side `escapeHtml()` string-replace helper — **not** `document.createElement`, which doesn't exist in Node. |
   | `POST /api/setup/test-connections` | `protect` | Reuses `credentials.testConnections()` for YouTube, plus a provider-aware AI check (find whichever of `credentials.openai`/`gemini`/`aiProvider` is actually populated and run `validateAIKey` against it) instead of the existing method's OpenAI-only hardcoding. |
   | `POST /api/setup/complete` | `protect` | Calls `completeSetup()`; on the "still incomplete" error, returns 409 with a message identifying what's missing (YouTube vs. AI) so the frontend can route the user back to the right step instead of a dead-end. |

## Frontend changes (dashboard/index.html, dashboard/app.js, dashboard/styles.css)

- New `<dialog id="setup-wizard-dialog">` with 3 steps (not 4 — channel/content basics is intentionally dropped, see below): **1) AI provider → 2) Video provider (optional, defaults to slideshow) → 3) YouTube connect**, followed by a summary/activate panel. Same `<dialog>`/`data-close` pattern as `#generate-dialog`.
- Dropdowns for AI/video provider + model are populated from `GET /api/setup/providers` on dialog open, not hardcoded.
- Step 1 "Test & save" button calls `POST /api/setup/ai-provider`; on success advances to step 2.
- Step 2 "Next" calls `POST /api/setup/video-provider` (or skips straight through if "Local slideshow" is left selected — no network call needed since that's already the DB default) before advancing to step 3.
- Step 3 "Connect YouTube": saves client id/secret via `POST /api/setup/youtube/credentials`, fetches `GET /api/setup/youtube/oauth-url`, opens it with `window.open(url, '_blank')` (Electron's existing `setWindowOpenHandler` in electron/main.js already routes this to the system browser via `shell.openExternal` — no change needed there), then polls `GET /api/setup/status` every ~2s until `youtube.connected` is true, and **displays the connected channel's title/thumbnail** right there once detected.
- Summary panel: on entry, fetch `GET /api/setup/status` and render the same style of capability checklist as `walkthrough.js`'s `stepFinish()` (script/image/TTS/FFmpeg/upload), plus the connected channel name. "Activate" calls `POST /api/setup/complete`; on success, closes the dialog and reloads the dashboard; on the 409 "incomplete" response, shows which step is still missing and jumps back to it instead of a generic failure toast.
- `#setup-banner` (dashboard/index.html:48): replace the `npm run walkthrough` `<code>` hint with a "Start setup wizard" button that opens the dialog.
- The existing `#settings-view`/`#profile-form` (channel name, goal, audience, brand voice, timezone, etc., saved to the DB's `channel_profiles` table) is **left untouched and not duplicated** — investigation confirmed `credentials.channel`/`credentials.content` (the CLI-only shape) are never read by any agent at runtime; the wizard intentionally has no "channel & content basics" step and instead points the user at the already-working Channel Setup view after activating.

## Verification

1. `npm test` and `npm run lint` after each backend change (existing suite must stay green).
2. Manual end-to-end in the Browser pane against `npm start`/the Electron preview, with a **fresh** `YAA_DATA_DIR` so it starts in `setupRequired: true` mode:
   - Open the dashboard, click "Start setup wizard", complete step 1 with a real (or intentionally invalid, to check the error path) AI key.
   - Step 2: leave slideshow selected, confirm no network error.
   - Step 3: enter YouTube client id/secret, click connect, complete the Google consent screen in the opened tab, confirm the wizard auto-detects completion and shows the real channel name/thumbnail.
   - Summary step shows the capability checklist; click Activate; confirm the dashboard reloads out of setup mode with no server restart.
3. Server-log check: confirm "Setting up automation scheduler" appears exactly once even after clicking Activate twice quickly (paste `POST /api/setup/complete` twice via curl to double-check the re-entrancy guard).
4. Confirm `npm run credentials:setup` and `npm run walkthrough` still work completely unchanged (neither file is modified).
5. Confirm a server started with credentials already fully configured (the normal returning-user case) still boots straight past setup mode as today — `completeSetup()` is never called in that path, only the new `syncEnvVars()` line is added to `initialize()`.
