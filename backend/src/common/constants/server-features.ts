/** Capabilities this server build advertises on `/api/auth/me`. Additive
 *  only: never remove an entry a shipped client may already check for. */
export const SERVER_FEATURES = [
  'deviceProfileExtensions',
  'hlsSubtitleRequest',
  'muxedAudioRendition',
] as const;

/** What the engine announces (`hello.features`) for each feature it serves. */
const ENGINE_FEATURE: Partial<
  Record<(typeof SERVER_FEATURES)[number], string>
> = {
  deviceProfileExtensions: 'decide',
  hlsSubtitleRequest: 'serve',
  muxedAudioRendition: 'serve',
};

/** The features this server advertises: those the engine announces. */
export function serverFeatures(
  engine: { engineFeatures: readonly string[] } | undefined,
): readonly string[] {
  return SERVER_FEATURES.filter((f) => {
    const needed = ENGINE_FEATURE[f];
    return !needed || !!engine?.engineFeatures.includes(needed);
  });
}
