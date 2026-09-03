"""Lớp gọi Claude API dùng chung cho mọi agent trong pipeline."""

from __future__ import annotations

import inspect
import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from .config import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
    estimate_cost_usd,
    supports_modern_features,
)
from .schemas import strict_json_schema

T = TypeVar("T", bound=BaseModel)

MAX_PAUSE_RESTARTS = 5


class ContentAgentError(RuntimeError):
    """Lỗi khiến pipeline phải dừng thay vì đoán bừa."""


def use_api_backend() -> bool:
    """CONTENT_AGENT_USE_API=true -> Messages API (tốn credit); mặc định -> `claude -p`."""
    return os.environ.get("CONTENT_AGENT_USE_API", "").strip().lower() in {
        "1", "true", "yes", "on",
    }


@dataclass
class UsageRecord:
    stage: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: Optional[float]


@dataclass
class ClaudeRunner:
    """Bọc client Anthropic: xử lý pause_turn, structured output, đếm chi phí.

    Tương thích cả SDK cũ (Python 3.8 chỉ cài được anthropic 0.72, chưa có
    `messages.parse`/`output_config` native) lẫn SDK mới: nếu `messages.create`
    không nhận `output_config` thì đẩy qua `extra_body`.
    """

    model: str = DEFAULT_MODEL
    client: Any = None
    max_tokens: int = DEFAULT_MAX_TOKENS
    verbose: bool = True
    usage_log: List[UsageRecord] = field(default_factory=list)
    backend: str = "dry-run"
    # stage -> model, đè lên `model` cho riêng lượt gọi đó.
    stage_models: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.client is None:
            if use_api_backend():
                self.client = self._anthropic_client()
                self.backend = "api"
            else:
                from .claude_cli import ClaudeCodeClient

                self.client = ClaudeCodeClient()
                self.backend = "claude-cli"
        try:
            params = inspect.signature(self.client.messages.create).parameters
            self._native_output_config = "output_config" in params
        except (TypeError, ValueError):  # client giả lập trong dry-run
            self._native_output_config = False

    @staticmethod
    def _anthropic_client():
        import anthropic  # import trễ để --dry-run không cần SDK

        # API key gắn với identity (không phải key của workspace) bắt buộc
        # gửi kèm header workspace id, nếu không API trả 400.
        workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID")
        headers = {"anthropic-workspace-id": workspace} if workspace else None
        return anthropic.Anthropic(default_headers=headers)

    def model_for(self, stage: str) -> str:
        """Model dùng cho một stage; `stage` có thể mang hậu tố retry (`script#1`)."""
        return self.stage_models.get(stage.split("#")[0], self.model)

    # ---------- API công khai ----------

    def text(
        self,
        stage: str,
        system: str,
        prompt: str,
        tools: Optional[List[dict]] = None,
        effort: Optional[str] = None,
    ) -> str:
        """Một lượt hỏi trả về text thuần."""
        response = self._create(
            stage, system, [{"role": "user", "content": prompt}], tools, effort
        )
        return self._first_text(response)

    def structured(
        self,
        stage: str,
        system: str,
        prompt: str,
        schema_model: Type[T],
        effort: Optional[str] = None,
        retries: int = 2,
    ) -> T:
        """Một lượt hỏi trả về object đã validate theo `schema_model`.

        Retry tối đa `retries` lần khi JSON sai schema; hết lượt thì raise
        thay vì trả dữ liệu nửa vời (§4 SPEC.md).
        """
        schema = strict_json_schema(schema_model)
        output_config: Dict[str, Any] = {
            "format": {"type": "json_schema", "schema": schema}
        }
        messages: List[dict] = [{"role": "user", "content": prompt}]
        last_error = ""

        for attempt in range(retries + 1):
            response = self._create(
                f"{stage}#{attempt}" if attempt else stage,
                system,
                messages,
                tools=None,
                effort=effort,
                output_config=output_config,
            )
            text = self._first_text(response)
            try:
                return schema_model.model_validate(json.loads(text))
            except (json.JSONDecodeError, ValidationError) as exc:
                last_error = str(exc)
                if self.verbose:
                    print(f"  ! {stage}: output sai schema, thử lại ({attempt + 1}/{retries})")
                messages = messages + [
                    {"role": "assistant", "content": text},
                    {
                        "role": "user",
                        "content": (
                            "Output vừa rồi không hợp lệ so với schema. Lỗi:\n"
                            f"{last_error}\n\nTrả lại JSON đúng schema, không kèm giải thích."
                        ),
                    },
                ]

        raise ContentAgentError(f"{stage}: không lấy được JSON hợp lệ sau {retries + 1} lần. {last_error}")

    def total_cost_usd(self) -> Optional[float]:
        costs = [r.cost_usd for r in self.usage_log]
        if any(c is None for c in costs):
            return None
        return sum(costs)  # type: ignore[arg-type]

    def usage_summary(self) -> dict:
        return {
            "model": self.model,
            "stage_models": dict(self.stage_models),
            "backend": self.backend,
            "calls": [vars(r) for r in self.usage_log],
            "total_input_tokens": sum(r.input_tokens for r in self.usage_log),
            "total_output_tokens": sum(r.output_tokens for r in self.usage_log),
            "total_cost_usd": self.total_cost_usd(),
        }

    # ---------- Nội bộ ----------

    def _create(
        self,
        stage: str,
        system: str,
        messages: List[dict],
        tools: Optional[List[dict]] = None,
        effort: Optional[str] = None,
        output_config: Optional[Dict[str, Any]] = None,
    ):
        model = self.model_for(stage)
        params: Dict[str, Any] = {
            "model": model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": list(messages),
        }
        if tools:
            params["tools"] = tools

        extra_body: Dict[str, Any] = {}
        config: Dict[str, Any] = dict(output_config or {})
        if effort and supports_modern_features(model):
            config["effort"] = effort
        if config:
            if self._native_output_config:
                params["output_config"] = config
            else:
                extra_body["output_config"] = config
        if extra_body:
            params["extra_body"] = extra_body

        restarts = 0
        while True:
            response = self._call_api(params)
            self._record_usage(stage, response, model)

            stop_reason = getattr(response, "stop_reason", None)
            if stop_reason == "refusal":
                details = getattr(response, "stop_details", None)
                raise ContentAgentError(
                    f"{stage}: model từ chối yêu cầu "
                    f"({getattr(details, 'category', 'không rõ lý do')})."
                )
            if stop_reason == "max_tokens":
                raise ContentAgentError(
                    f"{stage}: output bị cắt vì chạm max_tokens ({self.max_tokens}). "
                    "Tăng --max-tokens hoặc rút ngắn brief."
                )
            if stop_reason == "pause_turn":
                # Server tool (web search) đang chạy dở: nối lượt và gọi tiếp.
                restarts += 1
                if restarts > MAX_PAUSE_RESTARTS:
                    raise ContentAgentError(f"{stage}: pause_turn quá {MAX_PAUSE_RESTARTS} lần.")
                params["messages"] = list(params["messages"]) + [
                    {"role": "assistant", "content": response.content}
                ]
                continue
            return response

    def _call_api(self, params: Dict[str, Any]):
        from .claude_cli import ClaudeCLIError

        try:
            import anthropic
        except ImportError:  # dry-run với client giả lập, không cần SDK
            return self.client.messages.create(**params)

        try:
            return self.client.messages.create(**params)
        except anthropic.AuthenticationError as exc:
            raise ContentAgentError(
                "Xác thực thất bại. Đặt ANTHROPIC_API_KEY hoặc chạy `ant auth login`."
            ) from exc
        except anthropic.NotFoundError as exc:
            raise ContentAgentError(
                f"Model không tồn tại: {params.get('model', self.model)}"
            ) from exc
        except anthropic.RateLimitError as exc:
            raise ContentAgentError("Bị rate limit sau khi SDK đã tự retry. Thử lại sau.") from exc
        except anthropic.APIStatusError as exc:
            raise ContentAgentError(f"API lỗi {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise ContentAgentError("Không kết nối được tới API. Kiểm tra mạng.") from exc
        except ClaudeCLIError as exc:
            raise ContentAgentError(str(exc)) from exc

    def _record_usage(self, stage: str, response: Any, model: str) -> None:
        usage = getattr(response, "usage", None)
        input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
        # Backend claude-cli tự báo chi phí quy đổi; chỉ khi không có mới tra bảng giá.
        cost = getattr(usage, "cost_usd", None)
        if cost is None:
            cost = estimate_cost_usd(model, input_tokens, output_tokens)
        record = UsageRecord(
            stage=stage,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost,
        )
        self.usage_log.append(record)
        if self.verbose:
            cost = f"${record.cost_usd:.4f}" if record.cost_usd is not None else "n/a"
            # Chỉ nêu model khi bước này chạy model khác mặc định, để log khỏi dài.
            suffix = f" · {model}" if model != self.model else ""
            print(f"  · {stage}: {input_tokens} in / {output_tokens} out ({cost}){suffix}")

    @staticmethod
    def _first_text(response: Any) -> str:
        for block in response.content:
            if getattr(block, "type", None) == "text":
                return block.text
        raise ContentAgentError("Response không có text block nào.")
