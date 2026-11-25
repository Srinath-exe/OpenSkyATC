/* What a file is, from its first bytes. Not SVG or HTML: they can run script. Null = not accepted. */
export function sniff(b: Uint8Array): string | null {
  const s = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, 4) === 'GIF8') return 'image/gif';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'image/webp';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'audio/wav';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (s(4, 4) === 'ftyp') return s(8, 4) === 'qt  ' ? 'video/quicktime' : /^M4[AB]/.test(s(8, 3)) ? 'audio/mp4' : 'video/mp4';
  if (s(0, 4) === 'OggS') return 'audio/ogg';
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (s(0, 5) === '%PDF-') return 'application/pdf';
  return null;
}
/** The container a voice note and a recording share (WebM, MP4) is served as what it was sent as. */
export function servedType(found: string, said: string): string {
  return found === 'video/webm' && said === 'audio/webm' ? 'audio/webm' : found === 'video/mp4' && said === 'audio/mp4' ? 'audio/mp4' : found;
}
