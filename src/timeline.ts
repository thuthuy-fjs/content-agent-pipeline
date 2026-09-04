// The model only emits duration_sec per section;
// timestamps, syllable-based spoken-duration estimates, and drift checks are
// computed here so the model never has to do this arithmetic itself.

import type { VideoBrief } from "./brief";
import { MAX_DURATION_DRIFT_PCT, speechRate } from "./config";
import type { ScriptDraft } from "./schemas";

export interface TimedSection {
  name: string;
  goal: string;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  narration: string;
  visual_cue: string;
  syllable_count: number;
  spoken_sec: number;
}

export function overrunSec(section: TimedSection): number {
  return section.spoken_sec - section.duration_sec;
}

// Tieng Viet viet roi tung am tiet nen dem token trang la du chinh xac. Dung
// \p{L}\p{N} (Unicode-aware) thay vi [a-zA-Z0-9] de khong bo sot tu co dau.
const ALNUM_RE = /[\p{L}\p{N}]/u;

export function countSyllables(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter((t) => ALNUM_RE.test(t)).length;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.round(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function buildTimeline(script: ScriptDraft, brief: VideoBrief): TimedSection[] {
  const rate = speechRate(brief.language);
  const timeline: TimedSection[] = [];
  let cursor = 0;
  for (const section of script.sections) {
    const duration = Math.max(1, Math.trunc(section.duration_sec));
    const syllables = countSyllables(section.narration);
    timeline.push({
      name: section.name,
      goal: section.goal,
      start_sec: cursor,
      end_sec: cursor + duration,
      duration_sec: duration,
      narration: section.narration,
      visual_cue: section.visual_cue,
      syllable_count: syllables,
      spoken_sec: round1(syllables / rate),
    });
    cursor += duration;
  }
  return timeline;
}

export interface DurationReport {
  target_sec: number;
  planned_sec: number;
  spoken_estimate_sec: number;
  drift_pct: number;
  within_tolerance: boolean;
  overrunning_sections: { name: string; budget_sec: number; spoken_sec: number }[];
}

export function durationReport(timeline: TimedSection[], brief: VideoBrief): DurationReport {
  const planned = timeline.reduce((sum, s) => sum + s.duration_sec, 0);
  const spoken = round1(timeline.reduce((sum, s) => sum + s.spoken_sec, 0));
  const target = Math.max(1, brief.duration_target_sec);
  const drift = round1(((spoken - target) / target) * 100);
  return {
    target_sec: target,
    planned_sec: planned,
    spoken_estimate_sec: spoken,
    drift_pct: drift,
    within_tolerance: Math.abs(drift) <= MAX_DURATION_DRIFT_PCT,
    overrunning_sections: timeline
      .filter((s) => overrunSec(s) > 1.5)
      .map((s) => ({ name: s.name, budget_sec: s.duration_sec, spoken_sec: s.spoken_sec })),
  };
}
