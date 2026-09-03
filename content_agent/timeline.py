"""Tính timestamp và kiểm tra script có khớp ngân sách thời gian không.

Model chỉ đưa duration_sec từng section; timestamp và mọi phép so sánh thời
lượng đều tính ở đây để không phụ thuộc vào số học của model (§7 SPEC.md).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .brief import VideoBrief
from .config import MAX_DURATION_DRIFT_PCT, speech_rate
from .schemas import ScriptDraft


@dataclass
class TimedSection:
    name: str
    goal: str
    start_sec: int
    end_sec: int
    duration_sec: int
    narration: str
    visual_cue: str
    syllable_count: int
    spoken_sec: float

    @property
    def overrun_sec(self) -> float:
        """Số giây lời thoại vượt quá ngân sách section (âm là còn dư)."""
        return self.spoken_sec - self.duration_sec


def count_syllables(text: str) -> int:
    """Tiếng Việt viết rời từng âm tiết nên đếm token trắng là đủ chính xác."""
    return len([t for t in text.split() if any(c.isalnum() for c in t)])


def format_timestamp(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 60:02d}:{total % 60:02d}"


def build_timeline(script: ScriptDraft, brief: VideoBrief) -> List[TimedSection]:
    rate = speech_rate(brief.language)
    timeline: List[TimedSection] = []
    cursor = 0
    for section in script.sections:
        duration = max(1, int(section.duration_sec))
        syllables = count_syllables(section.narration)
        timeline.append(
            TimedSection(
                name=section.name,
                goal=section.goal,
                start_sec=cursor,
                end_sec=cursor + duration,
                duration_sec=duration,
                narration=section.narration,
                visual_cue=section.visual_cue,
                syllable_count=syllables,
                spoken_sec=round(syllables / rate, 1),
            )
        )
        cursor += duration
    return timeline


def duration_report(timeline: List[TimedSection], brief: VideoBrief) -> dict:
    planned = sum(s.duration_sec for s in timeline)
    spoken = round(sum(s.spoken_sec for s in timeline), 1)
    target = max(1, brief.duration_target_sec)
    drift = round((spoken - target) / target * 100, 1)
    return {
        "target_sec": target,
        "planned_sec": planned,
        "spoken_estimate_sec": spoken,
        "drift_pct": drift,
        "within_tolerance": abs(drift) <= MAX_DURATION_DRIFT_PCT,
        "overrunning_sections": [
            {"name": s.name, "budget_sec": s.duration_sec, "spoken_sec": s.spoken_sec}
            for s in timeline
            if s.overrun_sec > 1.5
        ],
    }
