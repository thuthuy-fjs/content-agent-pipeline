// Stage 3 — Script Agent (SPEC.md §3.3).
//
// Nhận outline đã được duyệt ở checkpoint (xem pipeline.ts) và viết lời thoại
// theo đúng cấu trúc/ngân sách đó — không tự chia lại section, vì cái người
// dùng vừa duyệt phải sống sót vào script. Timestamps vẫn không do model tính
// (code cộng dồn duration_sec, xem timeline.ts) để tránh lỗi cộng trừ.

import type { VideoBrief } from "../brief";
import { briefAsPromptBlock } from "../brief";
import { speechRate } from "../config";
import type { LLMRunner } from "../llm/runner";
import {
  SCRIPT_DRAFT_SCHEMA,
  validateScriptDraft,
  type OutlineDraft,
  type ResearchNotes,
  type ScriptDraft,
} from "../schemas";

const SCRIPT_SYSTEM = `Bạn là biên kịch video ngắn. Bạn nhận outline đã chốt và ghi chú nghiên cứu, viết kịch bản hoàn chỉnh để người khác cầm đi quay ngay.

Nguyên tắc:
- Bám đúng outline đã cho: đúng số section, đúng tên section, đúng duration_sec của từng section. Không thêm, bớt, hay đổi thứ tự section.
- Mọi con số, mốc thời gian, kết quả nghiên cứu trong lời thoại phải lấy từ ghi chú nghiên cứu. Không thêm số liệu mới.
- Thông tin nào trong ghi chú có confidence "low" thì hoặc bỏ, hoặc nói theo kiểu phỏng đoán ("có giả thuyết cho rằng..."), không khẳng định.
- Lời thoại là văn nói: câu ngắn, chủ ngữ rõ, đọc lên nghe tự nhiên. Không dùng gạch đầu dòng, không dùng ngoặc chú thích trong lời thoại.
- Mỗi section kèm một visual_cue cụ thể, mô tả được cảnh cần quay hoặc hình cần tìm, không nói chung chung như "hình minh hoạ".`;

function scriptPrompt(brief: VideoBrief, rate: number, outlineJson: string, researchJson: string): string {
  return `Viết kịch bản video theo outline đã chốt dưới đây.

BRIEF:
${briefAsPromptBlock(brief)}

OUTLINE ĐÃ DUYỆT (JSON) — bám đúng section, đúng duration_sec:
${outlineJson}

TỐC ĐỘ ĐỌC ƯỚC TÍNH:
- ${rate} âm tiết/giây, tức một section dài N giây thì lời thoại khoảng N x ${rate} âm tiết. Bám mức này, đừng viết dài hơn ngân sách section.

GHI CHÚ NGHIÊN CỨU (JSON):
${researchJson}

Trả JSON đúng schema: working_title và danh sách sections (name, goal, duration_sec, narration, visual_cue) — mỗi section khớp 1-1 với outline theo đúng thứ tự.`;
}

export async function runScript(
  runner: LLMRunner,
  brief: VideoBrief,
  research: ResearchNotes,
  outline: OutlineDraft
): Promise<ScriptDraft> {
  const rate = speechRate(brief.language);
  const prompt = scriptPrompt(brief, rate, JSON.stringify(outline, null, 2), JSON.stringify(research, null, 2));
  return runner.structured("script", SCRIPT_SYSTEM, prompt, SCRIPT_DRAFT_SCHEMA, validateScriptDraft, {
    effort: "high",
  });
}
