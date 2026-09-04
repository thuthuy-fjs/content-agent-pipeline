// Stage 5 — Metadata Agent (SPEC.md §3.5).

import type { VideoBrief } from "../brief";
import { briefAsPromptBlock, platformHint } from "../brief";
import type { LLMRunner } from "../llm/runner";
import { VIDEO_METADATA_SCHEMA, validateVideoMetadata, type ScriptDraft, type VideoMetadata } from "../schemas";
import { formatTimestamp, type TimedSection } from "../timeline";

const METADATA_SYSTEM = `Bạn phụ trách phần xuất bản của một kênh video: đặt title, viết description, chọn tags.

Nguyên tắc:
- Title bám đúng nội dung script, không giật tít quá nội dung có thật.
- Description viết cho người đọc trước, cho thuật toán sau.
- Tags là cụm từ người thật sẽ gõ khi tìm, không nhồi từ khoá rác.
- Không hứa hẹn thông tin mà script không có.`;

function metadataPrompt(
  brief: VideoBrief,
  title: string,
  scriptText: string,
  chapters: string
): string {
  return `Viết metadata xuất bản cho video sau.

BRIEF:
${briefAsPromptBlock(brief)}

YÊU CẦU THEO NỀN TẢNG:
${platformHint(brief)}

KỊCH BẢN (${title}):
${scriptText}
${chapters}
Trả JSON đúng schema:
- title_options: 3-5 phương án title.
- description: 1 đoạn hoàn chỉnh, đúng phong cách nền tảng.
- tags: 8-15 tag.
- hashtags: 3-6 hashtag (có dấu #, không dấu tiếng Việt, không khoảng trắng).`;
}

export async function runMetadata(
  runner: LLMRunner,
  brief: VideoBrief,
  script: ScriptDraft,
  timeline: TimedSection[]
): Promise<VideoMetadata> {
  const scriptText = timeline.map((s) => `[${s.name}] ${s.narration}`).join("\n\n");
  let chapters = "";
  if (brief.platform === "youtube_long") {
    const marks = timeline.map((s) => `${formatTimestamp(s.start_sec)} ${s.name}`).join("\n");
    chapters = "\nMỐC THỜI GIAN (đưa nguyên vào description dạng chương):\n" + marks + "\n";
  }

  const prompt = metadataPrompt(brief, script.working_title, scriptText, chapters);
  return runner.structured("metadata", METADATA_SYSTEM, prompt, VIDEO_METADATA_SCHEMA, validateVideoMetadata, {
    effort: "medium",
  });
}
