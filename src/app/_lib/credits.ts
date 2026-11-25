/* Everything in OpenATC made by others, with its licence. Shown on /credits and in Settings > About; the phone app has the
   same list (mobile/lib/src/ui/about_screen.dart). */
export interface Credit { title: string; what: string; licence: string; href?: string }
export interface CreditGroup { title: string; note?: string; items: Credit[] }

export const CREDIT_GROUPS: CreditGroup[] = [
  { title: 'Maps and airport data', items: [
    { title: 'Mapbox', what: 'The 3D map of the city and the terrain, drawn by Mapbox GL JS', licence: '© Mapbox, Mapbox Terms of Service', href: 'https://www.mapbox.com/about/maps' },
    { title: 'OpenStreetMap contributors', what: 'Runways, taxiways, stands, buildings and the map underneath', licence: '© OpenStreetMap contributors, ODbL 1.0', href: 'https://www.openstreetmap.org/copyright' },
    { title: 'Esri World Imagery', what: 'Satellite picture behind the simple 2D map', licence: '© Esri, Maxar, Earthstar Geographics and the GIS user community', href: 'https://www.esri.com/en-us/legal/terms/data-attributions' },
    { title: 'AWS Terrain Tiles', what: 'Ground heights of the classic 3D map (Mapzen: SRTM, Copernicus and others)', licence: 'Open data, sources listed by the provider', href: 'https://registry.opendata.aws/terrain-tiles/' },
    { title: 'Natural Earth', what: 'Land outlines of the world map on the start page', licence: 'Public domain', href: 'https://www.naturalearthdata.com' },
    { title: 'Endless ATC', what: 'The airport file format our airspace files follow', licence: 'Format only', href: 'https://www.endless-atc.com' },
  ] },
  { title: 'Aircraft', note: 'Every model, its authors and where to find the originals are listed in the notice files. Airline names, logos and liveries, and aircraft names, belong to their owners; they appear only to tell aircraft apart, and no owner endorses OpenATC.', items: [
    { title: 'FlightGear AI aircraft', what: 'The aircraft and their liveries, by the FlightGear community (Ian Tolosa, Brett Harrison, Innis Cunningham and many more)', licence: 'GNU GPL v2, source and changes in the notice', href: '/models/fleet/NOTICE.txt' },
    { title: 'Flightradar24 community models', what: 'Aircraft of the classic 3D map', licence: 'GNU GPL v2', href: 'https://github.com/Flightradar24/fr24-3d-models' },
  ] },
  { title: 'Voice models', items: [
    { title: 'ATC-ASR 110M', what: 'Hears your radio calls. Our model, fine-tuned from NVIDIA Parakeet TDT-CTC 110M', licence: 'CC BY-NC-SA 4.0 (non-commercial, from its training data)', href: 'https://huggingface.co/srinath-exe/skycontrol-atc-asr-110m' },
    { title: 'OpenATC command model', what: 'Turns what you said into a command. Our model, trained from scratch', licence: 'Apache-2.0', href: 'https://huggingface.co/srinath-exe/skycontrol-atc-command-2m' },
    { title: 'Paradee-8M by Sahil Mahendrakar', what: 'The pilots’ voices, distilled from Kokoro-82M', licence: 'Apache-2.0', href: 'https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.2' },
    { title: 'Whisper by OpenAI', what: 'Second opinion on the speech server', licence: 'MIT', href: 'https://github.com/openai/whisper' },
    { title: 'ElevenLabs', what: 'The narrator, effects and music of the tutorial', licence: 'Generated with ElevenLabs', href: 'https://elevenlabs.io' },
  ] },
  { title: 'Sounds and textures', items: [
    { title: 'USC Cinema and Sunset Editorial libraries', what: 'Aircraft engine and wind recordings, from archive.org', licence: 'CC0 1.0', href: 'https://archive.org/details/Red_Library_Aircraft_Jets' },
    { title: 'Kenney Interface Sounds', what: 'Button sounds', licence: 'CC0 1.0', href: 'https://kenney.nl/assets/interface-sounds' },
    { title: 'ambientCG', what: 'Asphalt, concrete and grass', licence: 'CC0 1.0', href: 'https://ambientcg.com' },
  ] },
  { title: 'Software', items: [
    { title: 'Next.js and React', what: 'The site', licence: 'MIT', href: 'https://nextjs.org' },
    { title: 'three.js', what: 'Aircraft and the classic map', licence: 'MIT', href: 'https://threejs.org' },
    { title: 'MapLibre GL JS', what: 'The simple 2D map', licence: 'BSD-3-Clause', href: 'https://maplibre.org' },
    { title: 'sherpa-onnx, ONNX Runtime, Transformers.js', what: 'Run the voice models', licence: 'Apache-2.0, MIT, Apache-2.0', href: 'https://github.com/k2-fsa/sherpa-onnx' },
    { title: 'GSAP', what: 'Motion', licence: 'GSAP standard licence', href: 'https://gsap.com' },
    { title: 'modern-screenshot', what: 'Screenshots in bug reports', licence: 'MIT', href: 'https://github.com/qq15725/modern-screenshot' },
    { title: 'Lucide', what: 'Icons', licence: 'ISC', href: 'https://lucide.dev' },
    { title: 'Simple Icons', what: 'GitHub, Hugging Face, X and LinkedIn marks, which belong to their owners', licence: 'CC0 1.0', href: 'https://simpleicons.org' },
    { title: 'DM Sans by Colophon Foundry', what: 'Typeface', licence: 'SIL Open Font License', href: 'https://fonts.google.com/specimen/DM+Sans' },
  ] },
];
