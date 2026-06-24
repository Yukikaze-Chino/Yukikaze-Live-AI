export function ttsProfileKindForSource(source) {
  return String(source || "manual").startsWith("ai") ? "ai" : "manual";
}

export function resolveTtsProfile(config, source) {
  const profileKind = ttsProfileKindForSource(source);
  const profile = config.ttsProfiles?.[profileKind] || config.tts;
  return {
    ...config,
    tts: {
      ...config.tts,
      ...profile,
    },
    ttsProfileKind: profileKind,
  };
}
