# Schema Studio relay

The small service on the internet that the desktop app's phone link goes
through. A phone and the computer it is paired with both open a WebSocket out
to the relay, and the relay passes their messages between them, so neither
has to accept connections from the internet.

The relay cannot read what it passes: the phone and the computer encrypt
everything end to end before it gets there. It knows only which computer a
message is for, and a computer has to prove that its room at the relay is its
own before anything is passed to it.

It runs on Cloudflare Workers, with one Durable Object, called a room here,
for each computer. A room that has nothing to do is taken out of memory but
keeps its connections open, and costs nothing while it sleeps.

## The code

- `src/worker.ts` checks each request and passes WebSocket connections on to
  the room of the computer they name.
- `src/room.ts` is the room as Cloudflare runs it, and `src/room-logic.ts`
  holds its rules: who may connect, signing in, and passing messages on.
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

`npm run check` type-checks the relay as Cloudflare runs it. `npm test` runs
the room's rules on their own, then the whole relay on this computer, run the
way Cloudflare runs it, with pretend computers and phones connecting to it.
The desktop workflow on GitHub runs both.

`npm run dev` starts the relay on this computer, to try it by hand.

## Deploying

Not yet. The relay will be deployed together with the phone app, which it
will also serve.
