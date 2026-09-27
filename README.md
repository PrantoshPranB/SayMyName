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
- Room tone is measured off the quiet end of the clip and subtracted, so
  silence draws flat instead of furry. Buckets are RMS rather than true peak,
  and the scale comes from the 98th percentile so one stray pop cannot squash
  everything else.
- Playback sweeps a real playhead across those bars, scaled by the media
  duration rather than by how long the recording felt.
- Name and phonetic spelling drive the preview card live; the slug is derived
  from the name at publish time.
- A draggable selection window over the wave, defaulting to the detected
  speech — which is what drops the click a microphone makes as it opens.
- **Clean up** (marked Pro) trims to the window, high-passes the rumble out,
  gates the room tone, lifts presence and levels the result. It toggles against
  **Original**, and the cleaned take is cached so that flip is instant: hearing
  the two against each other is the pitch, so it must not stall.
- **Signature** emits a speaker-emoji link for an Outlook signature. It points
  at the audio file rather than a page, because browsers autoplay a media file
  opened at the top level but refuse to autoplay a page — verified in Chrome.
- **Discard** clears the take and says so.
- **Lab** (testing only):
  - *Hear it like you do* — a playback-only filter (low shelf up, highs down)
    approximating the bone-conducted voice its owner hears. Never applied to
    what is published: listeners have only ever heard the air-conducted voice.
  - *Say it in another voice* — ElevenLabs speech-to-speech
    (`eleven_multilingual_sts_v2`) on the selected clip. It keeps the
    pronunciation and swaps the voice. The API key sits in `localStorage` and
    is sent from the page, which is acceptable on localhost only; a public
    build must proxy this through a server. Speech-to-speech, never
    text-to-speech: a TTS voice mispronounces exactly the names this is for.

## The paid line

Recording, the selection window, and the signature snippet are free. Clean up
is the Pro feature. There is no payment path yet, so it runs and then says what
it is — the Original/Clean up toggle is the demonstration, and gating it would
throw that away before anyone has heard the difference.

## Four things that make recording work, and are easy to undo by accident

1. **No `mimeType` passed to `MediaRecorder`.** Each engine's own default is
   its best-supported path. Forcing `audio/mp4` produced files that recorded
   but played back as noise.
2. **`autoGainControl: false`.** It rides the gain up through the quiet parts
   and hands back audible hiss. `noiseSuppression` and `echoCancellation` are
   the opposite — worth asking for explicitly, since engine defaults vary.
3. **The microphone and the `AudioContext` are released in `onstop`,** not on
   the line after `recorder.stop()`. `stop()` is asynchronous; tearing the
   input down straight after it cuts the final flush off mid-write, which
   truncates the take.
4. **`audioCtx.resume()` after `getUserMedia`.** Awaiting the permission
   prompt can cost the user-gesture context, and a suspended `AudioContext`
   makes the analyser read pure silence.

## Test publishing (GitHub Pages)

Until upload exists, publishing is a manual step on this machine (macOS):

1. In the studio, Publish → **Download for publishing**. That saves
   `<slug>.saymyname.json`: name, phonetic spelling, and the selected window
   as a WAV.
2. `node publish.js ~/Downloads/<slug>.saymyname.json` writes into `docs/`:
   `<slug>.m4a` (AAC, ~20 KB), `<slug>/index.html` (the card, with Open Graph
   tags) and `<slug>/card.png` (the preview image, rendered by headless Chrome).
3. Commit and push. GitHub Pages serves `docs/` on the domain in `docs/CNAME`.

Link to `<slug>.m4a` where a click should play at once (the signature 🔊);
link to `<slug>/` where a preview card helps (messages, profiles).

## What is deliberately not built

- **Upload.** Publish opens the sign-in modal and stops there. Nothing leaves
  the device.
- Accounts, payment, slug availability checks, bot protection, the card page.
- Transcoding. Clean up emits WAV, around 220 KB for two seconds. Browsers
  cannot encode MP3 or AAC natively, so publishing needs an encoder in the page
  or a transcode on upload to reach the ~25 KB the format deserves.
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
