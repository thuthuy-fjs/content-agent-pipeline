// Presentation/route constants — kept apart from config.ts, which is pipeline
// configuration (models, pricing, prompts).

export const PLATFORM_LABELS: Record<string, string> = {
  youtube_shorts: "YouTube Shorts",
  youtube_long: "YouTube (video dài)",
  tiktok: "TikTok",
  reels: "Instagram Reels",
};

export const DEFAULT_DURATION_SEC = 45;
export const MIN_DURATION_SEC = 5;
export const MAX_DURATION_SEC = 1800;

export const DURATION_UNITS = [
  { value: "sec", label: "giây", seconds: 1 },
  { value: "min", label: "phút", seconds: 60 },
];
export const UNIT_SECONDS: Record<string, number> = Object.fromEntries(
  DURATION_UNITS.map((u) => [u.value, u.seconds])
);

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_MAX_RECORDS = 500;
// Workers KV rejects expirationTtl < 60 at runtime (400 "Expiration TTL must
// be at least 60"), so 60 is the floor here, not a tuning choice.
export const HISTORY_CACHE_TTL_SEC = 60;
