# Grok Voice Patient Intake

A fictional family-medicine front desk built with
[LiveKit Agents](https://docs.livekit.io/agents/) and the
[xAI Grok Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech).
The agent can answer practice questions, find and manage appointments, route
messages, update insurance, collect pre-visit answers, and escalate possible
emergencies.

This example reimplements the workflow of LiveKit's
[xAI patient-intake demo](https://github.com/livekit-examples/python-agents-examples/tree/main/complex-agents/xai-patient-intake),
but replaces its separately configured speech-to-text, language, and
text-to-speech models with one native speech-to-speech connection:

```python
AgentSession(
    llm=xai.realtime.RealtimeModel(
        model="grok-voice-latest",
        voice="Ara",
    ),
    vad=None,
)
```

Grok listens to the caller's audio, reasons over the conversation, calls the
local clinic tools, and speaks the response. There is no separately assembled
STT → LLM → TTS cascade, VAD plugin, or turn detector in this example.

> The clinic and every patient are fake, in-memory teaching data. This is not a
> medical device, a source of medical advice, a production scheduling system,
> or a HIPAA-ready application. Never enter real patient information. The
> agent repeats this fake-data warning at the start of each call.

## Getting Started

Use Python 3.10 through 3.14.

Create a virtual environment and install the worker:

```bash
cd voice-agents/grok-patient-intake
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e ".[dev]"
```

Create `.env.local`:

```bash
cp .env.example .env.local
```

Fill in:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` from a
  [LiveKit Cloud project](https://cloud.livekit.io/).
- `XAI_API_KEY` from the [xAI Console](https://console.x.ai/).

LiveKit transports the call and xAI processes its audio, transcript, prompt,
and tool context. This worker does not start a recording, but recording can be
enabled elsewhere in a LiveKit deployment. Review both providers' current data
handling and retention settings before adapting the example.

Talk to the agent directly from the terminal:

```bash
python src/agent.py console
```

Or register the worker with LiveKit:

```bash
python src/agent.py dev
```

Then connect with the [LiveKit Agents Playground](https://agents-playground.livekit.io/)
or another LiveKit client that dispatches the agent named
`grok-patient-intake`. This focused cookbook port does not include the
upstream demo's custom Next.js frontend.

## Try the fake clinic

The seeded records are recreated for every call:

- Established adult: Jamie Example, born April 12, 1987.
- Established child: Riley Example, born September 3, 2018.
- New patients can use any obviously fake identity and phone number.

Example requests:

- “What are your office hours?”
- “I need to move my existing appointment.”
- “I am a new patient and need an appointment.”
- “I need a refill message for the nurse.”
- “I want to complete my pre-visit questions.”

## Tool surface

`src/agent.py` exposes eight typed tools:

| Tool | Purpose |
| --- | --- |
| `read_practice_information` | Read the fictional practice policy |
| `find_open_times` | Find suitable real slots in the in-memory clinic |
| `book_appointment` | Register a new patient when needed and book a chosen slot |
| `manage_appointment` | List, cancel, or reschedule an appointment |
| `take_message` | Route a refill, results, billing, referral, records, or nurse request |
| `update_insurance` | Save details from a fictional current insurance card |
| `record_previsit_intake` | Save a completed set of caller-provided intake answers |
| `record_emergency_escalation` | Record a possible emergency before urgent direction |

`src/clinic.py` contains the deterministic in-memory records. Tool calls mutate
only that per-call object; nothing is persisted or sent to an EHR.

## Voice configuration

The defaults follow the current xAI realtime recommendation:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `XAI_VOICE_MODEL` | `grok-voice-latest` | Tracks xAI's recommended realtime voice model |
| `XAI_VOICE` | `Ara` | Warm, friendly built-in voice |

The LiveKit xAI plugin supplies server-side voice activity detection and turn
handling. See the
[LiveKit xAI realtime guide](https://docs.livekit.io/agents/models/realtime/plugins/xai/)
for supported voices and lower-level options.

## Offline tests

The tests do not connect to LiveKit or xAI and do not consume API credits:

```bash
pytest
ruff check .
ruff format --check .
```

They verify the direct realtime composition, the exact eight-tool surface, fake
patient lookup, appointment state changes, new-patient eligibility, message
deduplication, intake storage, insurance updates, and emergency recording.

## Production safety

A real deployment needs authenticated patient access, consent and disclosure,
encrypted durable storage, EHR integration, audit logging, retention controls,
human escalation, regional emergency behavior, monitoring, and clinical/legal
review. It must also prevent room recording unless recording is explicitly
authorized and governed. Prompts alone do not provide those guarantees.
