# Security of the desktop app

This file says what the desktop app keeps safe, from whom and how, and what
it does not protect against. It covers the desktop app in `desktop/`, the
relay in `relay/`, the phone app the relay serves, and the apt source that
installed copies update from. The web app's own checks (who may do what, and
the SQL it runs) belong to the web app and are not covered here.

It is written for whoever works on the app next. Many of the checks below
look like extra code that could be tidied away, so before changing a file
named here, read what this file says about it.

## What needs protecting

- The passwords and connection strings of saved database connections. The
  web app encrypts them with `APP_ENCRYPTION_KEY` (AES-256-GCM, with a fresh
  random IV for each value, in `my-app/lib/secret-store.ts`), so that key
  matters as much as they do.
- This copy's other secrets: `NEXTAUTH_SECRET`, which signs sign-in cookies,
  the gate token (below), the GitHub token for the registry, the phone link's
  keys and the key that signs push messages.
- The databases themselves, which deploys and rollbacks change.
- The Microsoft sign-in, which decides who is using the app and what they
  may do.
- Approval decisions made from a phone.
- Backup files, which hold all of the above.
- The installed program and its updates.

## Who it guards against, and how

### Other programs and accounts on the computer

- The web app's server listens on `127.0.0.1` only (`src/main/server.ts`).
  Before Next.js sees a request, `src/server/desktop-gate.ts` turns it away
  unless it comes from this computer, is addressed to `127.0.0.1` on the
  app's port, and carries the gate token in the `x-schema-studio-gate`
  header. The token is made when the app starts, compared in constant time,
  and never shown to a page: the app adds it to the window's requests
  outside the page (`src/main/security.ts`, which also drops any copy a page
  tries to set), and to its own requests (`src/main/desktop-app.ts`). The
  gate refuses Upgrade and CONNECT requests too.
- Secrets reach the server's process in a message once it has started, not
  in its environment (`src/server/desktop-launcher.ts`), because the system
  keeps a copy of every process's starting environment, and ordinary tools
  (`ps e`) print it.
- PostgreSQL has no network port at all (`listen_addresses` is empty). It
  listens on a socket file that only its own account can open
  (`unix_socket_permissions` is 0700) and lets in only that account (peer
  sign-in, in `src/core/postgres-files.ts`). The socket's folder is
  `$XDG_RUNTIME_DIR/schema-studio`, or else `run` in the app's data folder,
  and only as a last resort `/tmp/schema-studio-<user id>`
  (`src/core/socket-dir.ts`).
- Secrets are kept in `secrets.json` (this copy's own keys), `auth.json`
  (the Microsoft sign-in) and `phone-link.json`, each readable by its owner
  only (0600), in a folder only its owner can open (0700). Where there is a
  login keyring (GNOME Keyring or KWallet), the contents are also locked with
  it through Electron's safeStorage, so a copy of a file on its own is no use
  to anyone (`src/main/secrets.ts`, `src/core/secrets-file.ts`). safeStorage's
  `basic_text` mode uses the same key on every computer, so the app counts it
  as no keyring at all.
- `ensurePrivateDir` (`src/core/private-dir.ts`) makes the app's private
  folders, and refuses one that is a link, is not a folder, or belongs to
  another account.
- The sign-in listener (`src/main/loopback-server.ts`) listens on
  `127.0.0.1` only and reads at most 64 KiB. A reply with the wrong state
  gets a 400 without ending the sign-in, so another program cannot spoil it
  by answering first.

### Web pages in the person's browser

- A web page cannot read from the app's server: it does not know the gate
  token, and DNS rebinding (a site's name pointed at `127.0.0.1`) fails the
  exact Host check.
- The relay turns away websockets from other sites' pages, that is, any
  Origin that is not the relay's own (`relay/src/worker.ts`).
- The sign-in uses PKCE (S256), state, a nonce and form_post
  (`src/main/auth.ts`), so a page that sees the browser's redirect cannot use
  the code. The sign-in's own requests use a session of their own
  (`src/main/net-client.ts`), which shares no cookies with the app's
  windows.
- The web app checks the ID token again itself (`verifyDesktopIdToken` in
  `my-app/lib/desktop-sign-in.ts`): Microsoft's published keys, RS256 only,
  the issuer, the audience, the pinned tenant, and an age of at most 10
  minutes.

### A page inside the app's window going bad

If a page in the window ever ran someone else's script (say, through a bug
that let a schema name become HTML), it still could not reach the computer:

- Every window is sandboxed, with context isolation, no Node.js and no
  `<webview>` (`src/main/windows.ts`).
- `src/main/security.ts` grants just two permissions (writing to the
  clipboard, and full screen) and only to the server's pages. It lets
  requests go only to the server and `app://`, lets the window move only
  between the server's pages (links open in the system browser), opens no
  new windows, and allows downloads only from the main window's pages.
- `app://` (`src/main/protocol.ts`) serves a fixed list of files, GET only,
  with a strict Content Security Policy.
- Every message to the app is checked in `src/main/ipc.ts`: it must come
  from the top frame of the exact page that may send it, and refusals are
  logged. The preloads (`src/preload/app-preload.ts` and
  `settings-preload.ts`) give their bridge only to their exact page.
- Pages never get a secret. Settings learns only whether each phone gets
  alerts and may approve, and how long it has left to set up a passkey. For
  a backup it gets the file's name without its folder.
- Electron's fuses (`electron-builder.config.cjs`) stop the app from running
  as plain Node.js, from reading `NODE_OPTIONS`, from taking a debugger from
  the command line, and from loading anything but its own `app.asar`.
  Cookies are encrypted, and `file://` gets no extra rights.

### The relay and the network

The relay passes messages between the computer and its phones. The team runs
it, and the app trusts it with nothing it carries.

- The computer and each phone talk through Noise IK
  (`Noise_IK_25519_AESGCM_SHA256`, in `src/shared/remote/noise.ts`, tested
  against the published test vectors). The phone learns the computer's key
  from the pairing code, never from the relay, so the relay cannot sit in
  the middle. Noise numbers every message, so the relay cannot replay,
  reorder or change one without the other end noticing.
- The computer signs in to its room on the relay by signing a fresh
  challenge with its own key (`src/shared/remote/relay-auth.ts`). The relay
  checks that the key is the one the computer's ID was made from
  (`checkChallenge`), so nobody else can sign in as that computer.
- The relay's address must be https (`src/shared/remote/relay-protocol.ts`).
  Message sizes are checked: 64 KiB for one relay message, 32 KiB pieces,
  and at most 8 MiB for one joined message, which is joined only from pieces
  that Noise opened (`src/shared/remote/link.ts`, `src/main/phone-relay.ts`).
  Anything the relay sends before the computer has signed in is ignored.
- The computer keeps at most 16 channels open at once, and a phone must send
  its handshake within 30 seconds (`src/main/phone-host.ts`). The relay
  keeps at most 8 phones and 2 connections signing in per room, and gives a
  computer 10 seconds to sign in (`relay/src/room-logic.ts`).

### A lost phone or a seen pairing code

- A pairing code holds a secret of 32 random bytes that works once, within 5
  minutes (`src/shared/remote/pairing.ts`). It is in the link's fragment
  (after `#`), which browsers never send to the relay. The app never logs
  it, and Settings gets only a picture of the QR code, never the link.
- A paired phone can make only the requests in `METHODS`
  (`src/shared/remote/rpc.ts`), and each one is read strictly: exact
  fields, types and lengths.
- It sees only the connections chosen in Settings (`src/main/phone-requests.ts`
  checks that first). Each request is made as whoever is signed in on the
  computer, with their permissions, so a phone can never do more than they
  could.
- Settings, then Phone, then Paired phones lists every phone. Removing one
  deletes its record, its push subscription and its passkey, and closes its
  channels at once (`forgetPhone` in `src/main/phone-link.ts`).
- Changing the relay turns approvals off on every phone, since a passkey
  only ever signs for the relay it was made at. Phones paired through the
  old relay need pairing again.
- Phone names are cleaned and cut at 64 characters before they are shown or
  logged.

### Approvals from a phone

A deploy or rollback request in the web app's approval queue can be approved
or rejected from a phone (`src/main/phone-approvals.ts`). The phone link's
keys alone decide nothing:

- A phone can set up a passkey only within 5 minutes of choosing Allow
  approvals for it in Settings, and only once each time.
- The passkey is kept with the phone, together with the app's hash of the
  email of whoever was signed in, and it decides as that person only. Once
  someone else signs in, the phone decides nothing until approvals are set
  up again.
- The passkey checks (`src/core/webauthn.ts`) accept only ES256 (P-256)
  keys, read with a strict CBOR reader, require both "user present" and
  "user verified", and check that the passkey belongs to the relay's name. A
  passkey that keeps a counter must give a higher one each time, or it is
  refused.
- Each decision signs a one-time number (32 random bytes, removed before it
  is checked), the request, the decision and a fingerprint of the request's
  exact SQL (`approvalChallenge` in `src/shared/remote/approval.ts`). The
  phone app (`relay/src/phone/approvals.ts`) works the fingerprint out from
  the SQL it shows, and offers Approve only when it matches, so the
  signature covers what the person saw.
- The computer checks the signature, that the fingerprint is still the
  request's and, to approve, that the SQL it holds still hashes to that
  fingerprint. The server then checks the fingerprint and the person again
  (`my-app/app/api/deploy/approvals/[id]/route.ts`), and the person must
  hold the `approvals:approve` permission. A request whose SQL changed, or a
  different person, gets 412, a decision the approval rules do not allow
  gets 403, and a request someone else decided first gets 409.
- The app adds no note of its own to a decision, and the phone gets fixed
  refusal sentences, never the server's own words.
- The Allow windows and one-time numbers are kept in memory only.

### Push services

- Drift alerts reach a phone through its browser maker's push service. The
  app sends only to Google's, Mozilla's, Apple's and Microsoft's push hosts
  (`src/core/web-push.ts`), over https on the default port, with no
  redirects and a time limit, so a phone cannot make the computer send
  requests anywhere else.
- Each message is encrypted for the phone (RFC 8291), so the push service
  cannot read it, and signed with this copy's own push key (VAPID).
- It says only what the desktop notification says (`src/main/phone-push.ts`),
  and only for connections that phones may see.

### The phone app in its browser

- The relay serves the phone app with a strict Content Security Policy
  (`relay/public/_headers`): only the app's own scripts and styles run, with
  no inline script or style, it can connect only to the relay it came from,
  and no other site can frame it. It may use the camera, and has the
  microphone and location turned off.
- The app builds its screens from text and never sets `innerHTML`
  (`relay/src/phone/dom.ts`), so nothing the computer sends can become
  markup.
- It runs only over HTTPS. It reads the pairing code from the address and
  takes it out of the address at once, and it logs nothing.
- The phone's own key is made so that the page can use it but never read it
  out, and is kept in the phone's IndexedDB with the paired computer's
  record (`relay/src/phone/idb-store.ts`).
- Its passkeys belong to the relay's name, need the person's face,
  fingerprint or screen lock each time, and use ES256, the one kind of key
  the computer checks.
- Its service worker keeps a copy of the app's own files only. It shows a
  push as a drift alert only when it is one it can read, and anything else
  as a fixed notice that it could not read it (`relay/src/phone/sw.ts`).

### Backup files

- A backup (`src/core/backup-file.ts`) is encrypted with a key that scrypt
  makes from the passphrase, set to need 128 MiB of memory for each guess,
  so guessing passphrases is slow. Passphrases are 12 to 1024 characters.
- The contents are encrypted with AES-256-GCM in 64 KiB pieces, each one
  numbered and the last one marked, with the file's header bound to every
  piece, so no piece can be dropped, reordered or swapped in from another
  backup. Nothing is used until the whole file has checked out.
- Restoring checks every value it reads, takes table and column names only
  from the live database, and writes values as parameters, never as SQL
  (`src/main/backup.ts`). Foreign keys are checked again before it finishes.

### Database contents in notifications

Drift notifications name only the schema and its connection (`driftAlert`
and `driftNotification` in `src/core/drift-alerts.ts`), never a host or an
error. Names are cleaned, cut at 48 characters and, on Linux, escaped so
that they cannot act as markup.

### The program and its updates

- The PostgreSQL that ships with the app is pinned by size and sha512
  (`scripts/fetch-postgres.mjs`), unpacked without running any of its
  scripts, and only its `bin`, `lib` and `share` folders are kept.
- The server build never copies `.env` files, and is deleted if a scan finds
  a `.env` value, or anything else that looks like a secret, in it
  (`scripts/build-server.mjs`). The installer holds no secrets: each copy
  makes its own when it first starts.
- npm installs come from the lock files, and Electron's own download is
  checked against its published checksums.
- The apt index is signed with a key that lives only in the secrets of the
  `desktop-release` environment on GitHub. apt checks it with the public key
  the package installs (`/usr/share/keyrings/schema-studio-archive-keyring.gpg`,
  named by `Signed-By`, so it is trusted for this source only). Publishing
  takes a tag push by someone who may write to the repository
  (`.github/workflows/desktop-release.yml`), and every workflow can only
  read the repository, apart from that publishing job.

### Logs

Every line the app writes goes through `redact` (`src/main/log.ts`,
`src/core/redact.ts`), which removes this copy's own secrets, ID tokens and
other JWTs, GitHub tokens, passwords in connection strings, password, token
and code values, emails, and the home folder. PostgreSQL's own log is
redacted when the diagnostics read it. Beyond that, the app never logs the
pairing link, challenges, one-time numbers or signatures, an approval's
SQL, the approver's email or its hash, push addresses and keys, a backup's
passphrase, or what a phone asked to compare.

## What it does not protect against

- **Malware running as the same account, or as root.** It can read the
  app's files, unlock the keyring as the person and talk to the server the
  way the app does. Nothing a desktop app does can stop that.
- **No login keyring.** Without GNOME Keyring or KWallet (or with only
  `basic_text`), secrets are protected by file permissions alone.
- **Someone who sees the QR code within its 5 minutes** can pair as a phone
  before the person does. The code works only once, every phone is listed in
  Settings and logged when it pairs, and a phone can be removed at once.
- **The phone app comes from the relay.** The relay cannot read or change
  what the computer and a phone say to each other, but it serves the phone
  app's code, so whoever controls the relay could serve an app that does
  something else. Keep the Cloudflare account that runs it locked down.
- **What the relay sees:** the computer's ID, IP addresses, and when and how
  much is sent.
- **The relay can always stop the phone link**, as anything in the middle of
  a network can. Someone who knows the computer's ID (it is in each pairing
  code) could also keep its room's 8 phone places full, which keeps phones
  out without letting anyone read anything.
- **Big messages from the relay.** The app checks each message's size once
  it has arrived, so a relay that sends a huge message could still make the
  app use a lot of memory before refusing it.
- **Passkey attestation is not checked.** The app does not ask what kind of
  authenticator made a passkey; the phone link vouches for the phone. A
  synced passkey may also be on the person's other devices.
- **Copied passkeys.** A passkey that keeps a counter is refused once its
  counter goes back, but synced passkeys keep no counter (they always say 0)
  and are accepted. If a phone's passkey is refused, set up approvals for it
  again.
- **The approver hash** is a SHA-256 of the email with a fixed label and no
  salt, so someone who can read it can test guesses. It stays on the
  computer, in the phone link's file.
- **Identity is the email** in Microsoft's ID token, from the pinned tenant.
- **A disabled account** keeps working on a computer that stays offline, for
  up to 30 days. Online, the app checks again every 6 hours.
- **The first person to sign in** to a new copy becomes its admin, so sign
  in yourself first.
- **The installed files** are protected by being owned by root. Linux has no
  fuse that checks `app.asar` before it is loaded.
- **The `/tmp` socket folder** is used only when the other two cannot be.
  Another account could make it first, but the app refuses a folder it does
  not own, so that could stop the app from starting, not let anyone in.
- **apt updates.** The index has no Valid-Until date, so someone who could
  give a computer an old copy of it could hold back its updates, though they
  would have to get past the https to GitHub first. Publishing a bad version
  takes both the signing key and permission to write to the repository;
  making the `desktop-release` environment need a reviewer on GitHub adds a
  second person. Local changes to the app's apt source file are lost on the
  next update, and unattended-upgrades does not install this source's
  updates unless it is told to.
- **GitHub Actions are pinned by major version**, not by commit, so a bad
  release of one could change what a workflow does.
- **A paired phone chooses its own push address.** It can only be at one of
  the allowed push services, and only gets the words of alerts the phone
  could see anyway.
- **Push services** see that an alert was sent, and its size, but not its
  words.
- **Restoring a backup replaces everything.** A backup made by someone else
  could hold their connections and secrets in place of yours. Restore only
  backups you made yourself.

## When you change the app

- A new phone request goes in `METHODS`, is read by the strict request
  reader, checks sharing before it reads anything, refuses with fixed
  sentences, and logs nothing secret.
- A new secret is kept by `src/main/secrets.ts`, registered with
  `addLogSecret`, and never sent to a page.
- A new window is sandboxed with context isolation, its file goes in the
  `app://` list, and its preload checks the exact page.
- A change to what a phone signs for an approval changes the label
  `schema-studio approval v1` too, so an old signature can never count under
  new rules.
- Anything newly logged goes through `redact`.
