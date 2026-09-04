// Renders script.md for the "Tệp" result tab.
// Recomputed on every read, never persisted (see notion.ts readRun).

import type { VideoBrief } from "./brief";
import type { DurationReport, TimedSection } from "./timeline";
import { formatTimestamp } from "./timeline";
import type { ResearchNotes, ScriptDraft } from "./schemas";

const CONFIDENCE_LABEL: Record<string, string> = { high: "cao", medium: "trung bình", low: "thấp" };

export function renderScriptMd(
  brief: VideoBrief,
  script: ScriptDraft,
  timeline: TimedSection[],
  report: DurationReport,
  research: ResearchNotes
): string {
  const lines: string[] = [
    `# ${script.working_title}`,
    "",
    `> Chủ đề: ${brief.topic}  `,
    `> Nền tảng: ${brief.platform} · Mục tiêu ${report.target_sec}s · ` +
      `Kịch bản ${report.planned_sec}s · Đọc thử ước tính ${report.spoken_estimate_sec}s ` +
      `(lệch ${report.drift_pct >= 0 ? "+" : ""}${report.drift_pct.toFixed(1)}%)  `,
    `> Tone: ${brief.tone} · Khán giả: ${brief.audience}`,
    "",
  ];

  if (!report.within_tolerance) {
    lines.push(
      "**Cảnh báo:** thời lượng đọc thử lệch quá ngưỡng cho phép — " +
        "cắt bớt hoặc thêm lời thoại trước khi quay.",
      ""
    );
  }
  if (report.overrunning_sections.length) {
    const over = report.overrunning_sections
      .map((s) => `${s.name} (${s.spoken_sec}s / ${s.budget_sec}s)`)
      .join(", ");
    lines.push(`**Section quá dài so với ngân sách:** ${over}`, "");
  }

  lines.push("---");
  for (const section of timeline) {
    lines.push(
      "",
      `## [${formatTimestamp(section.start_sec)}–${formatTimestamp(section.end_sec)}] ${section.name}`,
      "",
      `*Mục tiêu:* ${section.goal}`,
      "",
      `**Lời thoại:** ${section.narration}`,
      "",
      `**Hình ảnh:** ${section.visual_cue}`,
      "",
      `<sub>${section.syllable_count} âm tiết · đọc ~${section.spoken_sec}s / ` +
        `ngân sách ${section.duration_sec}s</sub>`
    );
  }

  lines.push("", "---", "", "## Nguồn tham chiếu", "");
  for (const fact of research.facts) {
    const source = fact.source_url || "không có nguồn";
    const label = CONFIDENCE_LABEL[fact.confidence] || fact.confidence;
    lines.push(`- [${label}] ${fact.claim} — ${source}`);
  }
  lines.push("");
  return lines.join("\n");
}
