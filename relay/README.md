# Schema Studio relay

The small service on the internet that the desktop app's phone link goes
through, and the home of the phone app. A phone and the computer it is
paired with both open a WebSocket out to the relay, and the relay passes
their messages between them, so neither has to accept connections from the
internet.

The relay cannot read what it passes: the phone and the computer encrypt
everything end to end before it gets there. It knows only which computer a
message is for, and a computer has to prove that its room at the relay is its
own before anything is passed to it.

It runs on Cloudflare Workers, with one Durable Object, called a room here,
for each computer. A room that has nothing to do is taken out of memory but
keeps its connections open, and costs nothing while it sleeps.

## The phone app

The relay also serves the phone app, the web app a phone opens to pair with
the computer (File, then Settings, then Phone, then Show a code, in the
desktop app). With it, the person holding the phone can:

- browse the schemas of the connections the computer shares with phones;
- compare a schema with the same schema on up to 6 other connections;
- approve or reject deploy and rollback requests after reading their exact
  SQL, with a passkey (Face ID, a fingerprint or the phone's screen lock),
  once approvals are allowed for that phone on the computer;
- get drift alerts, even while the app is closed.

It works only while Schema Studio is running on the computer, because the
computer answers everything the phone asks. It needs the relay's https://
address, because browsers allow the camera, passkeys and alerts only on
HTTPS pages, and a recent browser for the keys the link uses: iOS 17 or
later on an iPhone or iPad, or Chrome 133 or later on Android.

On an iPhone or iPad, open the relay's address in Safari, add it to the Home
Screen (Share, then Add to Home Screen), open it from there and scan the code
inside the app. Safari and the Home Screen app keep separate storage, so a
computer paired in Safari is not paired in the Home Screen app, and drift
alerts work only in the Home Screen app (iOS 16.4 or later).

Forget, in the phone app's Settings, forgets the computer on the phone only.
The computer keeps the phone in its list until it is removed there, under
Paired phones.

The phone app's Settings show its version. Each deploy of the relay is a new
version, which a phone picks up the next time it opens the app online.

## The code

- `src/worker.ts` checks each request and passes WebSocket connections on to
  the room of the computer they name. Requests for the phone app's files
  never reach it: Cloudflare serves those itself, from `public/`.
- `src/room.ts` is the room as Cloudflare runs it, and `src/room-logic.ts`
  holds its rules: who may connect, signing in, and passing messages on.
- `src/phone/` is the phone app, in TypeScript, with no framework and no
  bundler:
  - `main.ts` runs it: what it remembers, what it asks the computer, and
    which screen it shows. `screens.ts` builds the screens, and `dom.ts`
    builds their elements, always from text, never from HTML.
  - `connection.ts` keeps the link to the computer through the relay: the
    handshake, then requests and their answers.
  - `routes.ts` names each screen in the address after "#", so Back, a
    reload and the Home Screen icon all work.
  - `scan.ts` and `scanner.ts` read the pairing code with the camera, using
    jsQR, which loads only when the phone first scans.
  - `store.ts` and `idb-store.ts` keep the paired computer in IndexedDB,
    with its private key held so that the page can use it but never read it
    out.
  - `format.ts` and `approvals.ts` hold the words for what the computer
    sends, and the rules for what the phone offers for each request.
  - `sw.ts` is the service worker. It keeps a copy of the app's files, used
    only when the network does not answer, and shows drift alerts.
  - `clock.ts` and `build-info.ts` give the rest the time and the app's
    version.
- `public/` holds the page, its styles, icons and manifest, and `_headers`,
  whose Content Security Policy lets the page run only its own files.
- `scripts/build-phone.mjs` compiles the phone app into `public/js` and
  `public/sw.js`, which are not kept in git. `npm run build` runs it, and so
  do `npm test`, `npm run dev` and `npm run deploy`.
- `src/shared/remote/` is an exact copy of `desktop/src/shared/remote`, the
  code that the desktop app, the relay and the phone app share. Change the
  desktop app's files, then copy them here. A desktop test fails while the
  two differ.

## Testing

```bash
npm ci
npm run check
npm test
```

`npm run check` type-checks the relay as Cloudflare runs it, and the phone
app and its service worker as browsers run them. `npm test` builds the phone
app, then runs the room's rules on their own, then the whole relay on this
computer, run the way Cloudflare runs it, with pretend computers and phones
connecting to it, then the parts of the phone app that run without a page:
its link to the computer, routes, scanning, what it keeps, its words and its
service worker. The desktop workflow on GitHub runs both.

```bash
npm run e2e:phone
```

This runs the phone app from start to end in Google Chrome: two phones pair
with a computer through the relay, one by link and one with its camera, then
read a schema, compare two, set up approvals with a passkey, approve and
reject requests, turn drift alerts on and off, and forget the computer. The
computer is the desktop app's own phone link code, so compile that first
(`npm ci`, then `npm run build:ts`, in `desktop/`). It is not part of
`npm test` or the GitHub workflow, because it needs Chrome. A picture of each
screen, light and dark, goes to `out/phone-e2e`. Set `CHROME` to Chrome's
path when it is somewhere unusual.

`npm run dev` starts the relay on this computer at http://localhost:8787, to
try it by hand. While developing, the desktop app accepts
`http://localhost:8787` as its relay. A real phone needs the deployed relay,
because it cannot reach this computer's localhost, and its camera, passkeys
and alerts need HTTPS.

## Deploying

The relay runs on your team's own Cloudflare account. The free plan is
enough, because each room keeps its data in SQLite, which the free plan
allows.

1. Run `npx wrangler login` once, to let wrangler use the account.
2. Run `npm run deploy`. It builds the phone app, then uploads the relay and
   the phone app together, and prints the relay's address.
3. In the desktop app, type that address, starting with https://, under
   Relay (File, then Settings, then Phone), and Save.

Deploy to the same address each time. A phone's pairing and its passkey
belong to the relay's address, so moving the relay turns approvals off on
every phone and means pairing each phone again.
