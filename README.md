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

One self-contained `index.html`. Microphone access requires a secure origin,
so `file://` will not do in Chrome:

```sh
./serve.sh          # then open http://localhost:8000
```

## What works today

- Live recording via `MediaRecorder`, 15-second cap, unlimited re-takes.
- While recording, the bars are a live meter off the microphone. Once there is
  a file, the bars are re-measured from its decoded samples, so the picture and
  the sound are the same data.
- Playback sweeps a real playhead across those bars, scaled by the media
  duration rather than by how long the recording felt.
- Name and phonetic spelling drive the preview card live; the slug is derived
  from the name at publish time.
- **Discard** clears the take and says so.

## Four things that make recording work, and are easy to undo by accident

1. **No `mimeType` passed to `MediaRecorder`.** Each engine's own default is
   its best-supported path. Forcing `audio/mp4` produced files that recorded
   but played back as noise.
2. **Plain `{audio:true}` constraints.** `autoGainControl` rides the gain up
   through the quiet parts and hands back audible hiss.
3. **The microphone and the `AudioContext` are released in `onstop`,** not on
   the line after `recorder.stop()`. `stop()` is asynchronous; tearing the
   input down straight after it cuts the final flush off mid-write, which
   truncates the take.
4. **`audioCtx.resume()` after `getUserMedia`.** Awaiting the permission
   prompt can cost the user-gesture context, and a suspended `AudioContext`
   makes the analyser read pure silence.

## What is deliberately not built

- **Upload.** Publish opens the sign-in modal and stops there. Nothing leaves
  the device.
- Accounts, slug availability checks, bot protection, the public card page.
- Persistence. The take lives in memory only, so a refresh loses it. IndexedDB
  is the fix, but it is deliberately absent while recording is being tuned —
  restored state makes it much harder to tell a fresh bug from a stale take.

## The privacy position

Nothing is uploaded until someone publishes, so the page says exactly that, in
the two places it matters: under the record button, before anyone is nervous,
and in the sign-in modal.

Discard is honest work rather than theatre — there *is* something to delete, the
in-memory blob and its object URL — so the confirmation reads
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
