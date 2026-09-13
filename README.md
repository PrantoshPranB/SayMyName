# SayMyName

Record how your name is actually said. Share it as a link that opens in any
browser — including a locked-down corporate one where nothing can be installed
and where Outlook and Teams strip embedded audio.

## The shape of it

- **The studio** — record, listen, re-record, add the phonetic spelling, pick a slug.
- **The artifact** — `saymyname.app/<slug>`: a name, a phonetic line, a big play
  button. No login, no app, loads instantly.
- **The paste** — an email signature, a Teams profile, a LinkedIn headline, a QR
  code on a conference badge.

This repo is the studio, as a static web page.

## Running it

Microphone access requires a secure origin, so `file://` will not do:

```sh
./serve.sh          # then open http://localhost:8000
```

## What works today

- Live recording via `MediaRecorder`, 15-second cap, unlimited re-takes.
- Waveform drawn from live mic amplitude; grey at rest, green as it plays back.
- Name, phonetic spelling and slug drive the preview card live. The slug is
  derived from the name until you edit it yourself.
- The take persists in IndexedDB, so a refresh — or a future OAuth redirect —
  does not lose it.
- **Discard** clears both the in-memory blob and the IndexedDB copy.

## What is deliberately not built

- **Upload.** Publish opens the sign-in modal and stops there. Nothing leaves
  the device.
- Accounts, slug availability checks, bot protection, the public card page.

## The privacy position

Nothing is uploaded until someone publishes, so the page says exactly that, in
the two places it matters: under the record button, before anyone is nervous,
and in the sign-in modal.

Discard is honest work rather than theatre — there *is* something to delete, the
in-memory blob and the IndexedDB copy — so the confirmation reads
"Deleted. Nothing was ever uploaded."

Do not anywhere claim a recording was deleted "from our servers" before upload
exists. It would not be true, and it is not a claim the product needs.

## Next, roughly in order

1. Publish for real — Cloudflare R2 for the audio, Workers for the slug.
   A 3-second AAC clip is ~25 KB, small enough that each card can be a
   pre-rendered static HTML file with the audio inlined as base64. No database.
2. Slug availability, then accounts, so a link can be re-recorded later.
3. The iPhone app — the studio is where the craft lives and where the charge is.

## Two things to verify before building further

- **LinkedIn ships name pronunciation natively**, recorded in their mobile app
  and played on the profile. It is locked inside LinkedIn, which is the opening
  — but the idea is partially occupied. Confirm what it does today.
- **Corporate IT rewrites or blocks external links in signatures** at some
  organisations. Test against a real enterprise Outlook setup before committing.

## Browser notes

- Safari records `audio/mp4`; Chrome, Edge and Firefox record `audio/webm;codecs=opus`.
  `pickMimeType()` handles the split.
- A `beforeunload` warning guards against closing the tab on an unsaved take.
