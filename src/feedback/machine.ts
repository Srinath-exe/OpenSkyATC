import type { PickedElement } from "./element";
import type { Clip, MicState } from "./recorder";

export type Mode = "record" | "screenshot" | "highlight";
export interface Draft {
  mode: Mode;
  picked: PickedElement | null;
  shot: Blob | null;
  clip: Clip | null;
  voice: Clip | null;
  text: string;
  /** Pictures the person added, or a retake by screen share. */
  pictures: Blob[];
}
export type State =
  | { phase: "idle" }
  | { phase: "menu" }
  | { phase: "picking" }
  | { phase: "capturing"; mode: Mode; picked: PickedElement | null }
  | { phase: "recording"; seconds: number; mic: MicState }
  | { phase: "composing"; draft: Draft; voicing: number | null; confirmDiscard: boolean; error: string | null }
  | { phase: "sending"; draft: Draft };

/** Something must have been said: typed, a voice note, or a recording with a voice on it. */
export const saysSomething = (d: Draft) => !!(d.text.trim() || d.voice || d.clip?.hasVoice);
