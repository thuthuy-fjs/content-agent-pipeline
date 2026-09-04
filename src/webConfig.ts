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

/* Giới hạn tài nguyên: bật biến SINGLE_RUN_PER_VISIT thì mỗi lượt truy cập
   (một tab trình duyệt, giữ nguyên qua reload) chỉ được bấm chạy pipeline một
   lần. Không đặt biến -> chạy bao nhiêu lần cũng được. */
export function singleRunPerVisit(env: { SINGLE_RUN_PER_VISIT?: string }): boolean {
  const raw = String(env.SINGLE_RUN_PER_VISIT ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

// Vé "đã dùng lượt" của một lượt truy cập, giữ trong KV. Đủ dài để một tab mở
// cả ngày không lấy thêm lượt, và vẫn trên mức sàn 60 giây của KV.
export const VISIT_QUOTA_TTL_SEC = 86400;
export const VISIT_QUOTA_MESSAGE =
  "Tài nguyên bị hạn chế: mỗi lượt truy cập chỉ được chạy pipeline một lần.";

export const ACCESS_TOKEN_HEADER = "X-Access-Token";
export const ACCESS_DENIED_MESSAGE = "Cần token truy cập.";

/* Xác thực toàn bộ /api/* bằng một token dùng chung (bật bằng biến ACCESS_TOKEN
   ở server, xem worker.ts). Không đặt biến -> trả về null -> auth tắt hẳn, mọi
   request qua thẳng như trước — cùng quy ước "trống = tắt" với
   SINGLE_RUN_PER_VISIT/SHOW_PROVIDER_ERRORS. So khớp bằng "==="; đây là công cụ
   một người dùng, không đáng đánh đổi độ phức tạp của so sánh constant-time cho
   một kênh timing-attack cần hàng nghìn request chính xác để khai thác. */
export function requiredAccessToken(env: { ACCESS_TOKEN?: string }): string | null {
  const token = String(env.ACCESS_TOKEN ?? "").trim();
  return token || null;
}

/* Giờ VN cố định (UTC+7). Worker chạy ở UTC và không có "giờ địa phương" ổn
   định, nên cộng thẳng offset vào epoch rồi đọc bằng các getter UTC. */
export const VN_UTC_OFFSET_MS = 7 * 3600 * 1000;

export function vnClock(epochSec: number): string {
  const d = new Date(epochSec * 1000 + VN_UTC_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
