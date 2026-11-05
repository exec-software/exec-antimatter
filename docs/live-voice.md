# Live voice pair programming

The microphone beside the main chat composer opens live voice controls. **Start microphone** is
an explicit, per-session action. Opening a chat, starting Antimatter, or clicking the desktop
avatar’s Voice button does not start recording.

Voice uses the existing conversation and its selected coding model. When idle, recognized speech
starts a normal user turn. During work, speech joins an ordered guidance queue, separate from the
replaceable typed steer. Guidance appears at its transcript position and is marked queued,
delivered, or delivery not confirmed. It is consumed at the agent’s next between-step boundary;
it does not interrupt an in-flight command or approve a permission request.

## Local test configuration

- Audio input: **Local live transcription (Moonshine)** at the local Lemonade service,
  using **Realtime transcription** and `Moonshine-Medium-Streaming`. This English-only
  streaming recognizer runs on CPU and produces interim captions while the user speaks.
  Discovery advertises already-downloaded streaming models; it does not download or load them.
  Qwen3-Omni remains available for image/audio understanding through its existing source.
- Speech output: when installed and running, the local Lemonade service at
  `http://127.0.0.1:13305/api/v1` is discovered read-only as **Local speech (Kokoro)**.
  It uses `kokoro-v1`, voice `coral`. Discovery does not load a model, change chat sources,
  install software, or download weights. Spoken replies can be disabled without disabling input.
- Coding: whichever model the main conversation already selects. Voice does not replace it.

Voice settings accept existing compatible inference sources and explicit audio model IDs.
The single configuration editor lives in **Settings → Voice**. The chat's Voice settings shortcut
opens it; during an active session it is labeled **Stop & configure** and ends capture first.
Provider credentials and model downloads live in **Settings → Models & providers**.
Use **Transcriptions** only when the server implements `/audio/transcriptions`. A listed model
is not proof of audio support; **Check saved input** is discovery, not an inference test.
No browser cloud recognizer or operating-system speech fallback is used. Remote services require
explicit opt-in and HTTPS, and their normal credentials remain in the main process.

**Realtime transcription** sends bounded mono 16 kHz PCM chunks over a main-process WebSocket.
Interim captions are replaceable hypotheses, never submitted user messages. A pause or
hold-to-talk release closes the local utterance; native ASR segments are combined into one
message. Committing waits for both the server acknowledgement and the active segment's final
transcript. Model credentials stay in main, and changing conversations or stopping voice closes
the socket. See the [restoration validation](model-provenance/single-box-restoration.md) for
the synthetic accuracy and latency checks and their limits.

**Audio chat** and **Transcriptions** remain available for other compatible input models.
Those modes send complete WAV utterances (20 seconds maximum), serialize input requests, and
pause the microphone if three utterances accumulate. CPU inference with a 30B multimodal model
can be substantially slower than a dedicated speech recognizer.

Speech output streams into playback as audio arrives. Local Kokoro uses its native PCM stream;
other compatible speech sources use incremental WAV decoding when their server streams the
response. Antimatter sends bounded PCM chunks to the renderer and waits for playback capacity
before receiving more, so it does not need to buffer an entire spoken answer. Interrupt cancels
the request and clears queued playback. Servers that buffer their own response still delay the
first audio. Complete sentences and bounded clauses start narration while the answer is being
written; consecutive phrases share a playback timeline with at most about two seconds queued.

## Talking while the agent works

1. Choose the coding model and normal workspace/access settings.
2. Open Voice, check its sources, and explicitly start the microphone.
3. Speak a task. Continue giving guidance as the agent codes; it picks up each accepted utterance
   in order. Tool approvals still require their ordinary on-screen controls.
4. Concise answer-channel progress and final prose are spoken. Code, tool output, hidden reasoning,
   and old conversation history are not read aloud. Full answers remain in chat.
5. **Interrupt & listen** stops speech and resumes listening. It does **not** stop coding.
   The chat’s ordinary Stop button remains the control for stopping the coding turn.

In **Auto detect**, the browser keeps echo-cancelled capture available during playback. Sustained
user speech interrupts the spoken response and retains the onset of the new utterance. Echo
cancellation depends on the device and room; use **Hold to talk** if speaker bleed causes unwanted
interruptions. Hold-to-talk pauses the microphone track during playback until the user presses
the button or chooses **Interrupt & listen**. Interrupted narration is not replayed by later answer
deltas. Mute pauses capture; Stop ends the session and releases microphone tracks.

The selectable desktop avatar shows voice status and provides open, mute, interrupt, and stop
controls. Voice can continue with the main window hidden **only while the avatar is visible**.
Hiding both, changing conversation/page, reloading, renderer failure, or quitting stops capture.
Automatic application restarts wait until the voice session ends.

## Privacy and failures

Audio clips and generated playback remain in bounded memory; Antimatter does not persist raw
recordings. Recognized messages and guidance persist in normal conversation/carbon history.
Selected inference services may have their own logging. Do not speak secrets you would not type
in the same chat or send to that service.

A failed transcription can be retried from its retained in-memory clip. If recognized words
cannot be delivered, the panel preserves the transcript for retry, copy, or appending to the draft.
Stopping drops pending audio. Switching conversation/page ends voice and appends any recovered
unsent transcript to its original conversation's draft. Abrupt process death can still lose
in-memory recovery state; copy or keep it as a draft before reloading. A failed speech reply never cancels
coding or removes the text answer.
