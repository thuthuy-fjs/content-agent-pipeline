// Stage 2 — Outline Agent (SPEC.md §3.2).
//
// Chốt cấu trúc video (hook -> thân bài -> CTA) và ngân sách giây từng section
// TRƯỚC khi viết lời thoại đầy đủ — đây là thứ người dùng duyệt ở checkpoint
// trong pipeline.ts, nên phải tách khỏi Script Agent thay vì gộp chung.

import type { VideoBrief } from "../brief";
import { briefAsPromptBlock } from "../brief";
import type { LLMRunner } from "../llm/runner";
import { OUTLINE_SCHEMA, validateOutlineDraft, type OutlineDraft, type ResearchNotes } from "../schemas";

const OUTLINE_SYSTEM = `Bạn là producer dựng cấu trúc video ngắn từ ghi chú nghiên cứu.

Nguyên tắc:
- Chọn đúng 1 góc kể chuyện (angle) phù hợp nhất với brief, không gộp nhiều góc.
- Cấu trúc chuẩn: hook -> 2 đến 4 đoạn nội dung -> CTA.
- duration_sec của tất cả section cộng lại phải bằng đúng tổng thời lượng mục tiêu.
- Mỗi section có một mục tiêu (goal) rõ ràng, không mơ hồ như "giới thiệu chung".
- Không viết lời thoại ở bước này — chỉ dựng khung.`;

function outlinePrompt(brief: VideoBrief, researchJson: string, feedback?: string): string {
  const feedbackBlock = feedback
    ? `\nNGƯỜI DÙNG CHƯA DUYỆT BẢN OUTLINE TRƯỚC, GÓP Ý:\n${feedback}\nHãy dựng lại outline theo đúng góp ý này.\n`
    : "";
  return `Dựng outline cho video sau.

BRIEF:
${briefAsPromptBlock(brief)}

NGÂN SÁCH THỜI GIAN:
- Tổng thời lượng mục tiêu: ${brief.duration_target_sec} giây. Tổng duration_sec của các section phải bằng đúng ${brief.duration_target_sec}.

GHI CHÚ NGHIÊN CỨU (JSON):
${researchJson}
${feedbackBlock}
Trả JSON đúng schema: structure là danh sách section (section, duration_sec, goal), theo đúng thứ tự sẽ xuất hiện trong video.`;
}

export async function runOutline(
  runner: LLMRunner,
  brief: VideoBrief,
  research: ResearchNotes,
  feedback?: string
): Promise<OutlineDraft> {
  const prompt = outlinePrompt(brief, JSON.stringify(research, null, 2), feedback);
  return runner.structured("outline", OUTLINE_SYSTEM, prompt, OUTLINE_SCHEMA, validateOutlineDraft, {
    effort: "medium",
  });
}
