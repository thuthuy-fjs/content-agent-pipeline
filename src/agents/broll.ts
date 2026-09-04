// Stage 4 — B-roll / Visual Suggestion Agent (SPEC.md §3.4).
//
// Chạy song song với Metadata Agent (pipeline.ts) — cả hai chỉ đọc timeline đã
// dựng xong, không phụ thuộc nhau. Trả về đúng 1 entry cho mỗi section theo thứ
// tự timeline, không tự bịa timestamp (model không tính giờ, xem timeline.ts).

import type { VideoBrief } from "../brief";
import { briefAsPromptBlock } from "../brief";
import type { LLMRunner } from "../llm/runner";
import { BROLL_SCHEMA, validateBrollList, type BrollList } from "../schemas";
import type { TimedSection } from "../timeline";

const BROLL_SYSTEM = `Bạn phụ trách hình ảnh minh hoạ (B-roll) cho một kênh video ngắn.

Nguyên tắc:
- Với mỗi section, đọc visual_cue đã có và cụ thể hoá thành từ khoá tìm kiếm.
- search_keywords là tiếng Anh, 3-5 từ/cụm từ, dùng trực tiếp được trên Pexels/Storyblocks/Unsplash.
- shot_type ngắn gọn: close-up, wide, screen recording, text overlay, chart/graphic, v.v.
- note ghi rõ nếu cảnh này bắt buộc phải tự quay thay vì dùng stock (vd: cần diễn viên, cần địa điểm cụ thể).
- Trả đúng 1 entry cho mỗi section, đúng thứ tự đã cho — không gộp, không thêm section mới.`;

function brollPrompt(brief: VideoBrief, sections: TimedSection[]): string {
  const list = sections
    .map((s, i) => `${i + 1}. [${s.name}] visual_cue: ${s.visual_cue}\n   lời thoại: ${s.narration}`)
    .join("\n");
  return `Sinh gợi ý B-roll cho video sau, đúng ${sections.length} section theo thứ tự dưới đây.

BRIEF:
${briefAsPromptBlock(brief)}

CÁC SECTION:
${list}

Trả JSON đúng schema: items là mảng ${sections.length} phần tử, mỗi phần tử ứng với đúng 1 section ở trên theo thứ tự (section = tên section đó).`;
}

export async function runBroll(runner: LLMRunner, brief: VideoBrief, timeline: TimedSection[]): Promise<BrollList> {
  const prompt = brollPrompt(brief, timeline);
  return runner.structured("broll", BROLL_SYSTEM, prompt, BROLL_SCHEMA, validateBrollList, {
    effort: "medium",
  });
}
