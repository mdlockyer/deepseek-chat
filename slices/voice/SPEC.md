# SPEC: `slices/voice` (read-aloud and voice input)

## Purpose

Two speech features over the DeepSeek speech tools API:

- **Read-aloud**: plays an assistant reply through text-to-speech, streamed as raw PCM and played
  as it arrives.
- **Voice input**: records the microphone, transcribes it, and hands the text to the composer.

## Public entrypoint

`createVoiceSlice({ fetch, apiOrigin, apiKey, store, audio? })` returns:

| Member                                       | Meaning                                                                                                    |
| :------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `readAloud.toggle(messageId, text, onError)` | Start reading a reply, or stop it if it is the one being read. `onError` receives the user-facing message. |
| `readAloud.stop()`                           | Stop any reading (the app calls this on send, regenerate, session switch).                                 |
| `readAloud.getState()` / `subscribe`         | `{ status: 'idle' }` or `{ status: 'loading' \| 'playing', messageId }`.                                   |
| `createVoiceInput(onText)`                   | A voice-input controller: `toggle`, `cancel`, `dispose`, `getStatus`, `getAnalyser`, `available`.          |
| `useVoiceInput(onText)`                      | React binding of the controller, plus elapsed `seconds` while recording.                                   |
| `getTtsVoice()` / `setTtsVoice(voice)`       | The read-aloud voice, `stella` or `tide`.                                                                  |
| `VoiceSetting`                               | Settings row for the read-aloud voice.                                                                     |
| `ReadAloudButton`, `VoiceButton`, `Spectrum` | The slice's views.                                                                                         |

`apiKey()` and the voice are read when each operation starts, so a settings change applies to the
next one.

## Behavioural invariants

### Read-aloud

1. **One at a time.** Starting a reply stops any other reading. Toggling the reply being read stops
   it and leaves the state `idle`.
2. **Lifecycle.** `loading` from the toggle until the first audio is scheduled, then `playing`,
   then `idle` when the last scheduled chunk ends. A stream with no audio goes straight to `idle`.
3. **Request.** `POST {apiOrigin}/v1/tools/tts` with `Authorization: Bearer <key>` and body
   `{ text, voice_id, format: 'pcm', filter_markdown: true }`.
4. **PCM decoding.** 16-bit little-endian mono at 24 kHz; an odd trailing byte is carried into the
   next chunk, so chunk boundaries never shift samples.
5. **Errors** are reported through `onError` (never after a stop) and the state returns to `idle`.
   The message: HTTP 400 → "cannot be read aloud right now"; 401 → invalid key; 402 → insufficient
   balance; 429 → rate limited; a protocol error → the server's raw text; anything else → generic
   failure.

### Voice input

6. **Availability.** Outside a secure context `available` is false and `toggle` does nothing.
7. **Lifecycle.** `idle` → `toggle` → `recording` → `toggle` → `transcribing` → `idle`.
   `toggle` while transcribing cancels it. `cancel` returns to `idle` from any state and releases
   the microphone.
8. **Stale results are dropped.** After a cancel, a late microphone grant is released at once and a
   late transcription is ignored (no text, no toast).
9. **Transcription.** `POST {apiOrigin}/v1/tools/asr`, multipart field `file`
   (`recording.wav`, `audio/wav`: RIFF/WAVE, PCM, mono, 16 kHz, 16-bit). Non-blank text is trimmed
   and passed to `onText`; blank text shows "No speech detected"; any failure shows "Speech
   recognition failed". Nothing was recorded → no request.
10. **Microphone errors.** Permission denied / security error → "Microphone access is blocked";
    no device → "No microphone detected"; anything else → "Speech recognition failed".
11. **Length limit.** Recording stops by itself at `maxSeconds` with "Maximum recording length
    reached", and is transcribed. The WAV never exceeds `maxSeconds` of audio.

### Preferences

12. **Voice preference.** Stored under `chat-demo:tts-voice`. Unset or any value other than `tide`
    reads as `stella` (the service default). `setTtsVoice` saves it; the next read-aloud uses it.

## Facts

None consumed or published. `readAloud.stop()` is called top-down by the app.

## Tunable parameters

| Parameter                 | Value   | Meaning                                       |
| :------------------------ | :------ | :-------------------------------------------- |
| `START_DELAY`             | `0.1` s | Extra buffering before the first chunk plays. |
| `SAMPLE_RATE` (recording) | `16000` | Fixed by the ASR API.                         |
| `MAX_SECONDS`             | `120`   | Fixed by the ASR API.                         |
| `TTS_SAMPLE_RATE`         | `24000` | Fixed by the TTS API.                         |

## Ownership notes

- The DeepSeek API key belongs to `slices/account`; the app passes `account.getApiKey` in.
