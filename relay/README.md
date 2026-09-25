# CarFlip Copilot Live Relay

The Android app connects to `wss://YOUR-HOST/ws` with `Authorization: Bearer <COPILOT_TOKEN>`.

- `GET /health`
- `GET /state`
- WebSocket `/ws`
- Android -> relay: state, OCR and on-demand JPEG frames
- Relay -> Android: {"type":"command","command":"..."}
- Set `COPILOT_TOKEN` in the hosting environment.

This is a relay only. It does not expose the phone directly to the Internet.
