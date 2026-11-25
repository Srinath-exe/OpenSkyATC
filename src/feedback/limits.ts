export const LIMITS = {
  recordSeconds: 5 * 60,
  recordBytes: 44 * 1024 * 1024, // keep under fileBytes: the last chunk lands after the check
  voiceSeconds: 3 * 60,
  fileBytes: 50 * 1024 * 1024,
  stillEveryMs: 4000,
  stills: 12,
  consoleEntries: 50,
  networkEntries: 30,
  parallelUploads: 3,
};
/** On every element the reporter renders: keeps it out of screenshots and out of picking. */
export const UI_ATTR = "data-feedback-ui";
/** The app puts this on anything private; it is painted over in screenshots. */
export const MASK_ATTR = "data-feedback-mask";
