// The pipeline's input brief (SPEC.md §2). Only `topic` is required.

import { PLATFORM_HINTS, PLATFORMS } from "./config";

export { PLATFORMS };

export interface VideoBrief {
  topic: string;
  platform: string;
  duration_target_sec: number;
  tone: string;
  audience: string;
  language: string;
  must_include: string[];
  avoid: string[];
}

export const DEFAULT_TONE = "giáo dục, gần gũi, hơi hài hước";
export const DEFAULT_AUDIENCE = "khán giả phổ thông Việt Nam, 18-35 tuổi";

export function makeBrief(fields: Partial<VideoBrief> & { topic: string }): VideoBrief {
  return {
    topic: fields.topic,
    platform: fields.platform || "youtube_shorts",
    duration_target_sec: fields.duration_target_sec ?? 60,
    tone: fields.tone || DEFAULT_TONE,
    audience: fields.audience || DEFAULT_AUDIENCE,
    language: fields.language || "vi",
    must_include: fields.must_include || [],
    avoid: fields.avoid || [],
  };
}

export function platformHint(brief: VideoBrief): string {
  return PLATFORM_HINTS[brief.platform] || PLATFORM_HINTS["youtube_shorts"];
}

export function briefAsPromptBlock(brief: VideoBrief): string {
  const lines = [
    `- Chủ đề: ${brief.topic}`,
    `- Nền tảng: ${brief.platform} (${platformHint(brief)})`,
    `- Thời lượng mục tiêu: ${brief.duration_target_sec} giây`,
    `- Tone: ${brief.tone}`,
    `- Khán giả: ${brief.audience}`,
    `- Ngôn ngữ đầu ra: ${brief.language}`,
  ];
  if (brief.must_include.length) lines.push("- Bắt buộc có: " + brief.must_include.join("; "));
  if (brief.avoid.length) lines.push("- Phải tránh: " + brief.avoid.join("; "));
  return lines.join("\n");
}
