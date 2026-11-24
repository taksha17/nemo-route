# Multimodal endpoints (later phase)

NIM serves image, speech, and video generation outside the Chat Completions API.
This folder is the planned home for per-model adapters once free-tier endpoints
are confirmed for:

- Text-to-image
- Text-to-video
- Text-to-speech / speech-to-text

Investigation checklist:

1. Confirm which free catalog models expose dedicated generation routes.
2. Map each route to an OpenAI-compatible shape where possible.
3. Extend Scout capability tags (`image`, `audio`, `video` generation).
4. Add gateway routes and dashboard filters without spending chat RPM budget on probes.
