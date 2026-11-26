# OpenATC phone app

The game, native on the phone and played in portrait. No WebView:

- **The game** is the web game's own simulation, command parser, AI controllers and pilots (`src/lib/sim`, `src/lib/voice`, `simStore`). They run unchanged inside an embedded JS engine: QuickJS through `flutter_js`.
- **The map** is Mapbox (Standard style), with the web map's airport layers and the fleet as 3D GLB models.
- **The UI** is Flutter.
- **Speech** is recognised on the phone (sherpa-onnx).
- **The pilots** answer through the phone's text-to-speech.

```
Flutter app
 ├─ LandingScreen   the web landing: the SFO portrait film scrubbed by swiping (loops), data blocks / labels / HUD /
 │                  chapter copy on top, and at the end: tutorial, a seat at SFO, your own shift, speech model
 ├─ CourseScreen    the tutorial (/learn): the web course and coach in the core, the card + map cues + narrator
 ├─ ModelScreen     download the pinned speech model (progress, resume, SHA-256); skippable (typed calls)
 └─ GameScreen      Mapbox map + 3D fleet · three pills · flight board / card sheet · hold-to-talk radio bar
       GameController ── 20 Hz ──▶ AtcCore.tick(dt) / frame()  ──▶ AirportMap (GeoJSON → model + symbol layers)
                      ──  4 Hz ──▶ AtcCore.ui()                ──▶ board, card, radio, score, alerts, pilot voices
       hold to talk: mic → IsolateStt (hotwords = callsigns on frequency) → AtcCore.heard([text]) → sent / say again
```

## Layout

| Path | What |
|---|---|
| `core/core.ts` | the phone core: wraps the web game's `SimStore` (headless) as `ATC.*` (boot, tick, frame, ui, heard, command...) |
| `core/shims.ts`, `core/sound.ts` | DOM-free globals (localStorage, fetch of provided files, timers on the app's clock, ES2022 polyfills for QuickJS 2020); sound calls queued for the app |
| `core/course.ts`, `core/tutor.ts` | the tutorial: `src/game/Tutorial` (STEPS, missions, coach) run as is; Course.tsx's step flow; map cues queued and returned in lng/lat |
| `core/naming.ts` | the simple taxiway and stand names, baked ahead of time (Paris: 10 s → under 1 s in QuickJS) |
| `core/taxiLimits.ts` | what fits along each taxi line, baked ahead of time (Singapore, Tokyo: seconds at boot in QuickJS otherwise) |
| `core/osmAirport.ts` | returns the airport graph baked ahead of time (SFO: 17 s → 0.5 s boot in QuickJS; same data, checked) |
| `core/build.mjs` | `node mobile/core/build.mjs` → `assets/core/core.js` |
| `core/bake-airport.mjs` | `node mobile/core/bake-airport.mjs KSFO` → everything in `assets/airports/KSFO.*`: the OSM and airspace files, the baked graph, names and taxi limits, the flat ground, the small map for the airport list |
| `tool/fleet/bake.ts` | the fleet (`public/models/fleet`) → self-contained GLBs with the livery embedded, re-origined at the nose wheel |
| `lib/src/core/` | `AtcCore` (the JS runtime) and the Dart types of what it returns |
| `lib/src/game/` | `GameController`, `AirportMap` (Mapbox), `GameScreen`, `Fleet` (GLB lookup), `Voice` / `RadioVoice`, `sun.dart` |
| `lib/src/game/course_screen.dart` | the tutorial UI (parts bar, step card with its diagrams, mission card with the call as a button) |
| `lib/src/ui/` | `LandingScreen` + `landing_film.dart` (frames, tracks, swipe physics), `ModelScreen`, theme |
| `lib/src/models/`, `lib/src/stt/`, `lib/src/audio/` | speech model download, sherpa-onnx engine in an isolate, hotwords, mic |
| `assets/` | `core/core.js`, `airports/` (six airports), `fleet/` (188 GLBs + `map.json`), `landing/` (480 portrait story frames 720 x 1280 + `tracks.json`), `learn/` (the narrator's lines for the missions), `stt_models.json` |

### The landing film

From the web's portrait cut, one story frame in three (the overlays work in story frames):

```bash
python3 - <<'PY'
from PIL import Image
for k in range(480):
    Image.open(f'public/landing/sfo-p/f/{k*3:04d}.webp').convert('RGB').resize((720, 1280), Image.LANCZOS) \
        .save(f'mobile/assets/landing/f/{k:03d}.webp', 'WEBP', quality=55, method=5)
PY
cp public/landing/sfo-p/tracks.json mobile/assets/landing/
```

`RENDER=/some/dir flutter test test/render` draws the landing at six chapters to PNGs, without a phone, and plays
a shift and the tutorial on a 360 x 780 screen. That run uses the real core with the map stubbed out: board, flight
card, Send, menu, keyboard, the Approach seat, five tutorial steps. It fails on any layout overflow. It needs
`LIBQUICKJSC_TEST_PATH` as above.

### After changing the game's TypeScript

```bash
node mobile/core/build.mjs                  # the core
for i in KSFO KJFK LFPG OMDB WSSS RJTT; do node mobile/core/bake-airport.mjs $i; done   # when osmAirport.ts, osmExtras.ts, naming.ts, taxiLimits.ts, the stand plans, the OSM data or public/maps/ground changed (a stale bake would be used as is)
```

### The fleet

```bash
MAX=512 OUT=mobile/assets/fleet CARRIERS=UAL,ASA,SWA,DAL,AAL,SKW,ANA,JAL,CPA,SIA,BAW npx tsx mobile/tool/fleet/bake.ts
```

- **What ships.** Every type in plain white, plus the liveries of SFO's carriers (about 20 MB). Without `CARRIERS` you get every livery (about 43 MB).
- **Model frame in Mapbox** (measured headlessly with GL JS, same style spec as the native SDK): rotation `[0,0,0]` points the nose west and z turns clockwise, so `rotation = [bank, -pitch, heading + 90]`. The bake puts the origin at the nose wheel on the ground (the sim's position) and writes each model's own length to `map.json`. The app scales each aircraft by its real length divided by that.

## Toolchain (on the VPS)

Everything lives under `/opt` (Flutter 3.47, Temurin JDK 17, Android SDK 36, NDK 28.2):

```bash
source /opt/mobile-env.sh
cd mobile
flutter pub get
flutter analyze
LIBQUICKJSC_TEST_PATH=/opt/pub-cache/hosted/pub.dev/flutter_js-0.8.7/linux/shared/libquickjs_c_bridge_plugin.so flutter test
```

`test/airports_boot_test.dart` boots all six airports in that engine and prints how long each takes.

`test/core_quickjs_test.dart` runs the real core in flutter_js's QuickJS on the host. It boots SFO, runs ten sim minutes and sends a spoken call. It also runs the tutorial through its tour and its first three missions.

## Build

```bash
flutter build apk --release --target-platform android-arm64 --dart-define=APP_VERSION=2.2.0 \
  --dart-define=MAPBOX_TOKEN=$(grep ^NEXT_PUBLIC_MAPBOX_TOKEN= ../.env.local | cut -d= -f2-)
(cd android && ./gradlew --stop)   # free the Gradle daemon's RAM on the shared host
```

- **Mapbox token.** `MAPBOX_TOKEN` is required: without it the map stays blank. The web's public token works without a referrer. Mobile maps are billed per monthly active user (25,000 a month are free).
- **Signing.** Release builds use the key named in `android/key.properties` (git-ignored: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`), or the debug key when that file is missing. Keep the key safe: an update must be signed with the same one.
- **ABIs.** Only `arm64-v8a` is packaged; `-Pall-abis=true` keeps every ABI, e.g. for an x86_64 emulator.
- **Gradle fixes for plugins:**
  - `android/build.gradle.kts` applies Kotlin to `mapbox_maps_flutter`, which skips it on AGP 9, and adds JitPack, where flutter_js's QuickJS comes from.
  - `gradle.properties` downgrades Kotlin's JVM-target check to a warning, because flutter_js mixes Java 11 and Kotlin 1.8.
- **iOS** needs a Mac (`flutter build ios`), plus the Mapbox token and a microphone usage string. It is untested.

## Run on your phone, wirelessly (Samsung / Android 11+)

1. **Developer options.** On the phone, go to Settings → About phone → Software information and tap Build number 7 times. Then go to Settings → Security and privacy → Auto Blocker and turn it off.
2. **Wireless debugging.** Go to Developer options → Wireless debugging (same Wi-Fi as the Mac) and choose Pair device with pairing code.
3. **Pair from the Mac.**
   ```bash
   brew install --cask android-platform-tools
   adb pair <ip>:<pair-port>        # type the 6-digit code
   adb connect <ip>:<port>          # "IP address & Port" on the Wireless debugging screen
   adb devices
   ```
4. **Tunnel the Mac's adb to the VPS** and keep it open:
   `ssh -N -R 5038:localhost:5037 -R 8181:localhost:8181 root@<vps>`
5. **Install or run from the VPS:**
   ```bash
   ANDROID_ADB_SERVER_PORT=5038 adb devices
   ANDROID_ADB_SERVER_PORT=5038 adb install -r build/app/outputs/flutter-apk/app-release.apk
   ANDROID_ADB_SERVER_PORT=5038 flutter run --device-vmservice-port 8181 --host-vmservice-port 8181 \
     --dart-define=MAPBOX_TOKEN=...     # debug build with hot reload
   ```

The wireless debugging port changes when Wi-Fi drops. If it does, run `adb connect` again; you don't need to pair again.

Logs: `adb logcat | grep -i -E 'flutter|mapbox|sherpa'`.

## Update the speech model

1. Pick the files (Hugging Face, pinned to a commit: `https://huggingface.co/<repo>/resolve/<40-hex commit>/<file>`).
2. Download them once and hash them: `sha256sum *.onnx tokens.txt bpe.model; stat -c %s ...`.
3. Add an entry to `assets/stt_models.json` with a new `version` (or a new `id`), set `active` to it. Roles:
   transducer = `encoder`, `decoder`, `joiner`, `tokens` (+ `bpe_model` when `"hotwords": true`);
   moonshine = `encoder`, `merged_decoder`, `tokens`.
4. Benchmark it first: `dart run tool/stt_bench.dart --manifest assets/stt_models.json --model <id> --dir <local dir> --out /tmp/b`,
   then `cp ../ml/gpu/results/stt/clips.json /tmp/b && ../ml/.venv/bin/python ../ml/stt/score.py --dir /tmp/b` for WER and
   command accuracy.
5. Ship the app. On start it sees the new version is not installed, downloads it, verifies every file, writes
   `.installed.json` and deletes the previous version's directory.

`flutter test test/manifest_test.dart` checks that every entry is well-formed and pinned to a commit.

## Sound

`lib/src/audio`: `soundscape.dart` (pure: traffic + camera -> loops and one-shots; four engine classes by type and length),
`sfx.dart` (SoLoud, volumes, ducking; everything but the press itself is silent while the player transmits, so the speaker
never reaches the recogniser), `film_sound.dart` (the landing film, scrubbed by the swipe), `TapSounds` (every tappable thing
clicks). Volumes: Menu > Aircraft / Buttons & radio.

The sounds (`assets/sound/*.wav`) are built, not edited by hand: `tool/sound/fetch_sources.py` then `tool/sound/build.py`
(both with `SRC=dir`), which checks levels, loop seams and that bigger engines are darker. Sources, all CC0 1.0 (no credit
required): the USC Cinema / Sunset Editorial libraries on archive.org (Gold Tape 05-06, 08-11, 16-18; Red Library Aircraft
Jets / Misc, Nature Wind) and Kenney's Interface Sounds; the fan tones, radio and alarms are synthesised (`synth.py`).

`flutter_soloud` compiles its native code in a build hook, so `flutter test` on the host needs clang: put the NDK's on PATH
(`/opt/android-sdk/ndk/<v>/toolchains/llvm/prebuilt/linux-x86_64/bin`). Adding it needs a reinstall, not a hot reload.

## Models and updates

Two models run on the phone: the speech model (downloaded) and the command model (bundled in `assets/s1`, the web's weights, run by
`lib/src/s1`: token-for-token equal to `src/lib/voice/s1.ts`, test/s1_test.dart). To push a new version to web and phones: put the files in a
NEW folder under `public/models`, edit `scripts/models.release.json` (version + notes), `node scripts/model-release.mjs`, deploy. Players who
have the model are asked (Update / Later / Skip this version); the old one is used until the new one has been verified.
A command model must have its safety gate fitted first (`ml/verify/refit.sh`); without `gate.json` neither side will use it.
