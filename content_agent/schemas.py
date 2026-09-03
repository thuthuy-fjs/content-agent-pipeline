"""Schema output của từng agent + bộ chuyển sang JSON Schema strict cho API."""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Type

from pydantic import BaseModel

try:  # pydantic >= 2 luôn có, giữ fallback cho typing của Python 3.8
    from typing import Literal
except ImportError:  # pragma: no cover
    from typing_extensions import Literal  # type: ignore

Confidence = Literal["high", "medium", "low"]


class Fact(BaseModel):
    claim: str
    source_url: str
    confidence: Confidence


class ResearchNotes(BaseModel):
    topic_summary: str
    facts: List[Fact]
    angle_suggestions: List[str]
    hook_ideas: List[str]
    open_questions: List[str]

    def low_confidence_ratio(self) -> float:
        if not self.facts:
            return 1.0
        low = sum(1 for f in self.facts if f.confidence == "low")
        return low / len(self.facts)


class ScriptSection(BaseModel):
    name: str
    goal: str
    duration_sec: int
    narration: str
    visual_cue: str


class ScriptDraft(BaseModel):
    working_title: str
    sections: List[ScriptSection]


class VideoMetadata(BaseModel):
    title_options: List[str]
    description: str
    tags: List[str]
    hashtags: List[str]


def strict_json_schema(model: Type[BaseModel]) -> Dict[str, Any]:
    """Chuyển pydantic model sang JSON Schema mà structured output chấp nhận.

    Ba việc: inline hết `$ref`/`$defs`, ép `required` = toàn bộ property,
    và đặt `additionalProperties: false` cho mọi object.
    """
    raw = model.model_json_schema()
    defs = raw.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, list):
            return [resolve(item) for item in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            name = node["$ref"].rsplit("/", 1)[-1]
            return resolve(copy.deepcopy(defs[name]))
        out = {k: resolve(v) for k, v in node.items() if k not in ("title", "default")}
        if out.get("type") == "object" or "properties" in out:
            out.setdefault("type", "object")
            out["required"] = list(out.get("properties", {}))
            out["additionalProperties"] = False
        return out

    return resolve(raw)
