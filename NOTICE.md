# Licences and credits

**Code:** MIT (see `LICENSE`).

**Media:** the landing film frames (`public/landing/`), the tutorial narration, clips and music (`public/learn/`) and the
style previews (`public/looks/`) are © 2026 Srinath-exe, all rights reserved. They are here so the game runs as it does
live; please don't reuse them elsewhere.

**Models**

| | licence |
|---|---|
| OpenATC command model S1-2M (`public/models/s1/`), [on Hugging Face](https://huggingface.co/srinath-exe/skycontrol-atc-command-2m) | Apache-2.0 |
| ATC-ASR 110M, [on Hugging Face](https://huggingface.co/srinath-exe/skycontrol-atc-asr-110m) (not in this repo), fine-tuned from NVIDIA Parakeet TDT-CTC 110M | CC BY-NC-SA 4.0, because part of its training data (UWB-ATCC, ATCOSIM) is non-commercial |
| Paradee-8M pilot voices (`public/models/tts/`, by sahilmahendrakar) | Apache-2.0, see its `LICENSE` and `NOTICE` |
| Moonshine (on-device speech option, loaded from its own host) | MIT |
| Textured aircraft and airline liveries (`public/models/fleet/`), from FlightGear's AI aircraft, converted by `scripts/fleet/convert_fg.py` | GNU GPL v2, see `public/models/fleet/LICENSE` and `NOTICE.txt` (authors, source, changes) |

**Data**

- Airport layouts, taxiways and stands: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL 1.0.
- Terrain: AWS Terrain Tiles (Mapzen terrarium: SRTM, Copernicus and others).
- Satellite imagery is **not** included; its terms do not allow redistribution. `scripts/bake_world.py` fetches what it
  needs when you bake an airport.
