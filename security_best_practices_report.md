# FreeJam security audit — 2026-11-09

## Executive assessment

**Hold public production release pending remediation.** Reviewed source commit
`fe020d9df24289adf942fcc8d5c47fe5e530053d`. The live origin/main ref returned
that same hash through the authenticated Git bridge. This audit changes no runtime
code and does not certify Marketplace acceptance or guarantee absence of flaws.

Two high-severity findings affect session authority and availability. Additional
findings affect mailbox registration, relay capacity, deployment defaults and
release packaging. Some limitations are already disclosed in README.md; disclosure
does not remove their impact. A small, trusted private group has a narrower threat
model than an internet-accessible relay.

## Remediation status

The following fixes have since been applied locally on `main` after this audit:

- Finding 1: host reconnects now require a separate 256-bit host credential that
  is stored only in the host's local configuration; FJ1 guest codes still carry
  only the guest session key.
- Finding 2: relay and notifier parsing now cap aggregate message bytes and
  fragments, time out incomplete messages, validate masking/control/fragment
  rules, reject unsupported frames, and rate-limit frames. Relay clients also
  have bounded idle time and outbound queues.
- Finding 4: global and per-source live connection limits, room/mailbox caps,
  per-source mailbox allocation budgets, idle timeouts and outbound queue limits
  now bound resource use. This does not replace deployment-level firewall and
  process limits.
- Finding 5: Docker now uses Node 24 Alpine and runs as an unprivileged user;
  the package engine and README require Node 24 or newer.
- Findings 6 and 7: bundle inputs now come from tracked files, secret-like
  configuration paths are excluded, the source archive is checked for unsafe
  paths and common credential patterns, notifier bundles use the same
  tracked-file allowlist, and the missing `render.yaml` reference is removed.

Finding 3 remains unresolved: preventing first-owner mailbox squatting requires
binding a stable mailbox ID to cryptographic ownership and migrating existing
friend identities. A random registration secret alone cannot prove first
ownership. Existing relay rooms also need a relay restart when deploying the
host-credential change, because rooms created by the old relay have no host-only
credential. The package build and archive path inspection succeeded locally;
phone behavior, live relay behavior and Spotify playback remain unverified.

## Scope and method

- Reviewed extension, custom Node HTTP/WebSocket relay, notifier, installers,
  uninstallers, hooks, PowerShell packaging/deployment helpers, Dockerfile,
  service units, manifest, README and preview image.
- Used the security-best-practices skill's vanilla JavaScript frontend guidance.
  No framework-specific backend reference applies to this raw Node HTTP server.
- Exercised the actual relay upgrade/data handlers in a Node VM with in-memory
  sockets. Exercised the actual notifier WebSocket parser similarly. These are
  bounded reproductions, not attacks against a deployed relay.
- Scanned 140 unique historical text blobs across all locally known branches and
  remote-tracking refs for common credential formats, private keys, suspicious
  secret assignments, complete FreeJam codes, network addresses and user paths.
- All three JavaScript entry points pass `node --check`; all five PowerShell
  scripts pass the PowerShell syntax parser. These checks do not prove behavior.
- package.json declares no third-party npm dependencies or test script. No npm
  dependency vulnerability report is claimed; runtime/platform risks remain.

## High severity

### 1. Guest join key authorizes host takeover

**Locations:** freejam.js:223; freejam-relay.js:678, :692, :704.

Evidence: join codes contain `k: config.key`; the relay chooses the role from
`url.searchParams.get("role")` and only checks `room.key !== roomKey`. A connection
using `role=host` closes the existing host with code 4005.

**Impact:** anyone given a normal guest join code can replace the real host,
broadcast playback state, obtain host-visible member IDs and kick other guests.

**Reproduction:** created a legitimate host and guest, then connected a third
socket with the guest-known key and `role=host`. The legitimate host was ended
and the attacker was registered as host. Changing role through a `hello` message
is correctly prevented, but reconnecting bypasses that protection.

**Fix:** issue a separate host-only credential; never include it in guest codes.
Verify it on host creation/reconnection and assign connection IDs server-side.
Apply room capacity checks to every role. Existing codes/protocol need migration.
**Mitigation:** trusted participants and network access restrictions. README.md:926
already documents this trust limitation; it remains a blocker for strong host isolation.

### 2. Fragmented WebSocket messages bypass memory and message-rate limits

**Locations:** freejam-relay.js:417, :730, :750; notifier/freejam-notifier.js:296,
:385, :393, :400.

Evidence: frame/input-buffer sizes are checked, but fragments are appended to a
separate array without an aggregate byte/count limit. Relay message rate accounting
only runs when the final fragment is received. The notifier has the same aggregate
fragment gap despite its larger per-buffer limit.

**Impact:** a relay client can exhaust relay memory; a malicious/compromised relay
can exhaust notifier memory. A relay attacker needs no existing user's secrets:
creating a new mailbox with attacker-chosen keys is enough.

**Reproduction:** delivered twenty unfinished 64 KiB fragments. The relay retained
1,310,720 bytes despite its 65,536-byte message limit, left the connection open,
and recorded zero messages. The notifier also retained 1,310,720 bytes despite its
1 MiB input limit. No large-volume memory exhaustion was attempted.

**Fix:** enforce cumulative message bytes and fragment counts before allocating,
bound incomplete-message duration and frame/control-frame rates, and stop parsing
after close. Enforce masking, reserved-bit and continuation/control-frame rules.
Prefer a maintained, pinned WebSocket implementation where practical.
**Mitigation:** private relay access and process resource limits; TLS alone does
not prevent this. RFC 6455 explicitly calls for reassembled-message limits:
https://www.rfc-editor.org/rfc/rfc6455.html#section-10.4

## Medium severity

### 3. First-connection mailbox claiming permits identity squatting

**Locations:** freejam-relay.js:319, :625, :627, :631.

Evidence: an unknown user ID is registered with the caller's receive key. Sending
`hello` with any send key makes it ineligible for the inert-mailbox recovery path.

**Impact:** someone who knows a user's ID before its first registration (for
example after a relay restart and from a previously shared friend code) can claim
the mailbox, deny the real owner access, and authenticate as that ID. Combined
with knowledge of a recipient's shared send key, this can impersonate that friend
to the recipient's ID-based friend filter. This does not reveal the owner's real
receive key or overwrite an already established legitimate mailbox.

**Reproduction:** registered a known victim ID with attacker keys, completed hello,
disconnected, then tried the owner's different receive key. The owner was rejected
and attacker ownership persisted in the map until process restart.

**Fix:** cryptographically bind stable IDs to owner keys, such as public-key IDs
and signed challenges, or securely persist previously established ownership.
Do not treat knowledge of an ID as proof of identity. A migration is required.
**Mitigation:** restrict relay membership; recreating identities is only recovery.

### 4. Anonymous allocation can permanently consume relay capacity

**Locations:** freejam-relay.js:41, :229, :360, :612, :625, :773.

Evidence: anyone can register arbitrary mailbox IDs. Disconnection deliberately
retains mailboxes, there is no mailbox expiry/registration quota, and the 10,000
mailbox cap then rejects new owners. Rooms also have no global allocation cap;
socket idle timeout is disabled at :539. Client.send at :90 does not bound pending
socket output or respond to backpressure.

**Impact:** an internet client can deny new mailbox registrations until restart;
many connections or slow receivers can further consume memory/CPU. notifyWatchers
scans every mailbox's connected clients, increasing work as allocation grows.

**Validation:** confirmed retention after disconnect in finding 3 and inspected
the allocation/cap/cleanup branches. Did not open 10,000 connections or measure
production exhaustion. This is separate from the fragment-limit bypass.

**Fix:** add global/per-source connection and registration budgets, safe ownership
persistence with inactive-state cleanup, idle timeouts, and outbound queue limits.
Do not expire ownership in a way that recreates finding 3.
**Mitigation:** firewall/VPN or authenticated edge access plus resource limits.

### 5. Deployment image selects an unsupported runtime

**Locations:** Dockerfile:1 (`FROM node:20-alpine`); package.json:11; README.md:219.

Node 20 reached end of life on 2026-04-30; documentation and engines also allow
Node 18, already end of life. Unsupported versions do not receive normal security
maintenance. This is a deployment risk, not proof of a particular exploitable CVE
in an uninspected installed container.

**Fix:** use a currently supported, patched LTS image, preferably non-root with
a reproducible digest/update policy, and align engines/install instructions.
**Mitigation:** operators can deploy on a supported patched runtime immediately.
Source: https://nodejs.org/en/about/eol and
https://github.com/nodejs/Release#release-schedule

### 6. Full-source ZIP does not honor secret exclusions

**Location:** scripts/build-bundles.ps1:56.

Evidence: `robocopy $repoRoot $full /E /XD .git dist /XF *.zip *.log` copies the
working directory, including ignored `.env` variants, node_modules and private
notifier config if placed there. Git ignore rules do not apply to robocopy.

**Impact:** a future source ZIP can disclose local configuration/secrets even if
Git remains clean. No such current file or leaked ZIP was found in the repo;
this is a confirmed unsafe packaging rule with conditional exposure.

**Fix:** package an explicit allowlist or reviewed tracked files, add a final
archive secret scan, and exclude environment/config files explicitly.
**Mitigation:** inspect ZIP contents before distribution and keep secrets outside
the source directory. No installer or bundler was run during this review.

## Low severity and release hygiene

### 7. Packaging references a missing deployment file

**Location:** scripts/build-bundles.ps1:69.

The relay ZIP requires `render.yaml`, which is absent from the current tracked
tree and disk. Copy-RepoFile will throw after earlier ZIPs have been produced,
leaving a partially completed release build. Remove the obsolete reference or
restore the intended file, then build and inspect archives. Static path existence
checked; no deployment or packaging side effects were triggered.

## Secrets, privacy and historical state

- No matches for the scanned credential/private-key/full setup-code patterns in
  the 140 historical text blobs; no tracked `.env`/key/config file found in the
  current tree. Pattern scans cannot detect every arbitrary credential.
- The inspected preview has sample UI names and no visible live codes/addresses.
- **main and origin/main history:** three old extension blobs contain a concrete
  numeric LAN example, not a credential. No numeric Tailscale address or Windows
  user path matched in that ancestry. Current examples are placeholders.
- **Other local branches:** `0a`, `backup-pre-rewrite-2026-11-08` and `switch` still
  reach numeric Tailscale/LAN addresses and a Windows user path. Whether an address
  was actually assigned to the user is unverified. No address is reproduced here.
  The prior claim that every local branch was scrubbed is not supported by this
  audit. No history or branches were changed/deleted.
- Local remote-tracking refs are not an inventory of every remote ref, fork,
  release archive, PR cache or GitHub-retained object. Only live origin/main was
  queried. Remote archival cleanup is outside this audit's verified scope.
- Git author identities are expected repository metadata and are not API secrets.

## Reviewed controls and practical limits

The only extension innerHTML assignment is a constant panel template (:3125).
Dynamic labels use textContent (:155); no demonstrated DOM injection, eval path,
Spotify token exfiltration or Premium Jam endpoint call was found. Playback URI
checks and per-listener ad guards exist. Notification subprocess text uses base64
or argument/environment passing rather than interpolating peer names into code.
Friend codes omit receive keys; the UI/notifier filter invites against added IDs,
subject to finding 3. Wrong established mailbox keys and guest hello-role changes
are rejected. These are positive observations, not comprehensive formal proofs.

Relay keys travel in WebSocket query strings and may reach proxy/access logs;
operators should redact queries and use WSS on public networks. Plain WS is an
intentional LAN/private-VPN mode; no public deployment's TLS/proxy configuration
was inspected. Base64 join/friend/notifier codes are encoding, not encryption.
The relay can read payloads. Extension secrets remain in Spicetify storage; other
privileged extensions or a compromised local account may read them.

No physical phone, Spotify desktop session, actual Windows/macOS notifier install,
Docker build, public relay, firewall, live TLS endpoint, or Marketplace acceptance
test was performed. A phone health-page check alone cannot validate playback.

## Before public submission

Resolve findings 1–6, repair the packaging reference, add focused regression tests
for role isolation/identity ownership/fragments/resource budgets, build and inspect
release artifacts, and run a two-client Spotify smoke test. Test any claimed phone
flow separately. Decide explicitly whether to remove historical private details on
other branches; history rewriting and force-pushing require separate authorization.

Audit reproduction script is saved locally at
`local audit script` and is not included in release
source. It uses bounded in-memory fixtures and intentionally confirms current
weaknesses; it is not a passing security regression suite.
