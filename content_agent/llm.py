"""Lớp gọi Claude API dùng chung cho mọi agent trong pipeline."""

from __future__ import annotations

import inspect
import json
import os
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from .config import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_MODEL,
    PROVIDER_UNAVAILABLE,
    estimate_cost_usd,
    supports_modern_features,
)
from .schemas import strict_json_schema

T = TypeVar("T", bound=BaseModel)

MAX_PAUSE_RESTARTS = 5


class ContentAgentError(RuntimeError):
    """Lỗi khiến pipeline phải dừng thay vì đoán bừa."""


def provider_error(detail: str) -> ContentAgentError:
    """Ghi chi tiết ra stderr, trả về lỗi với thông báo chung cho người dùng."""
    print(f"[provider] {detail}", file=sys.stderr)
    return ContentAgentError(PROVIDER_UNAVAILABLE)


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

    platform: str = "claude"
    model: str = DEFAULT_MODEL
    client: Any = None
    max_tokens: int = DEFAULT_MAX_TOKENS
    verbose: bool = True
    usage_log: List[UsageRecord] = field(default_factory=list)
    backend: str = "dry-run"
    # stage -> model, đè lên `model` cho riêng lượt gọi đó.
    stage_models: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Client truyền sẵn nghĩa là --dry-run. Phải xét TRƯỚC mọi phân nhánh theo
        # platform: chatgpt/gemini không đi qua self.client, nên nếu để platform
        # quyết định trước thì dry-run trên hai nền tảng đó gọi thẳng API thật.
        if self.client is not None:
            self.backend = "dry-run"
            self._native_output_config = self._detect_native_output_config()
            return

        if self.platform != "claude":
            self.backend = self.platform
            self._native_output_config = True
            return

        self.client = self._anthropic_client()
        self.backend = "api"
        self._native_output_config = self._detect_native_output_config()

    def _detect_native_output_config(self) -> bool:
        try:
            params = inspect.signature(self.client.messages.create).parameters
            return "output_config" in params
        except (TypeError, ValueError):  # client giả lập trong dry-run
            return False

    @property
    def is_dry_run(self) -> bool:
        return self.backend == "dry-run"

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

        raise provider_error(f"{stage}: không lấy được JSON hợp lệ sau {retries + 1} lần. {last_error}")

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
        # FakeClient nhái đúng bề mặt của SDK Anthropic, nên dry-run đóng gói
        # tham số y hệt đường claude — kể cả output_config, thứ fake.py cần để
        # sinh dữ liệu đúng schema.
        anthropic_shape = self.is_dry_run or self.platform == "claude"
        if tools and anthropic_shape:
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
        if anthropic_shape and extra_body:
            params["extra_body"] = extra_body

        restarts = 0
        while True:
            if self.is_dry_run:
                response = self._call_api(params)  # qua self.client = FakeClient
            elif self.platform == "chatgpt":
                response = self._call_openai_api(params)
            elif self.platform == "gemini":
                response = self._call_gemini_api(params)
            else:
                response = self._call_api(params)
            
            self._record_usage(stage, response, model)

            stop_reason = getattr(response, "stop_reason", None)
            if stop_reason == "refusal":
                details = getattr(response, "stop_details", None)
                raise provider_error(
                    f"{stage}: model từ chối yêu cầu "
                    f"({getattr(details, 'category', 'không rõ lý do')})."
                )
            if stop_reason == "max_tokens":
                raise provider_error(
                    f"{stage}: output bị cắt vì chạm max_tokens ({self.max_tokens}). "
                    "Tăng --max-tokens hoặc rút ngắn brief."
                )
            if stop_reason == "pause_turn":
                # Server tool (web search) đang chạy dở: nối lượt và gọi tiếp.
                restarts += 1
                if restarts > MAX_PAUSE_RESTARTS:
                    raise provider_error(f"{stage}: pause_turn quá {MAX_PAUSE_RESTARTS} lần.")
                params["messages"] = list(params["messages"]) + [
                    {"role": "assistant", "content": response.content}
                ]
                continue
            return response

    def _call_api(self, params: Dict[str, Any]):
        try:
            import anthropic
        except ImportError:  # dry-run với client giả lập, không cần SDK
            return self.client.messages.create(**params)

        try:
            return self.client.messages.create(**params)
        except anthropic.AuthenticationError as exc:
            raise provider_error(
                "Anthropic: xác thực thất bại, kiểm tra ANTHROPIC_API_KEY trong .env."
            ) from exc
        except anthropic.NotFoundError as exc:
            raise provider_error(
                f"Anthropic: model không tồn tại: {params.get('model', self.model)}"
            ) from exc
        except anthropic.RateLimitError as exc:
            raise provider_error("Anthropic: rate limit sau khi SDK đã tự retry.") from exc
        except anthropic.APIStatusError as exc:
            raise provider_error(f"Anthropic: HTTP {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise provider_error("Anthropic: không kết nối được tới API.") from exc

    def _record_usage(self, stage: str, response: Any, model: str) -> None:
        usage = getattr(response, "usage", None)
        input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
        # Backend nào tự báo chi phí thì dùng số đó; không có mới tra bảng giá.
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
        raise provider_error("Response không có text block nào.")

    def _get_api_key(self, key_name: str) -> Optional[str]:
        val = os.environ.get(key_name)
        if val: return val
        # Fallback to .env manually
        env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith(f"{key_name}="):
                        return line.split("=", 1)[1].strip()
        except OSError:
            pass
        return None

    def _call_openai_api(self, params: Dict[str, Any]):
        api_key = self._get_api_key("OPENAI_API_KEY")
        if not api_key:
            raise provider_error("OpenAI: thiếu OPENAI_API_KEY")
        
        messages = []
        if params.get("system"):
            messages.append({"role": "system", "content": params.get("system")})
        for msg in params.get("messages", []):
            messages.append({"role": msg.get("role", "user"), "content": self._first_text_from_msg(msg.get("content", ""))})

        payload = {
            "model": params["model"],
            "messages": messages,
            "max_tokens": params.get("max_tokens", 4000)
        }
        
        output_config = params.get("output_config")
        if output_config and "format" in output_config:
            schema = output_config["format"].get("schema")
            if schema:
                payload["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "structured_output",
                        "schema": schema,
                        "strict": True
                    }
                }
        
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST"
        )
        
        max_retries = 3
        for attempt in range(max_retries):
            try:
                with urllib.request.urlopen(req) as response:
                    res_data = json.loads(response.read().decode("utf-8"))
                    choice = res_data["choices"][0]
                    text = choice["message"].get("content") or ""
                    return SimpleNamespace(
                        content=[SimpleNamespace(type="text", text=text)],
                        stop_reason="end_turn",
                        usage=SimpleNamespace(
                            input_tokens=res_data.get("usage", {}).get("prompt_tokens", 0),
                            output_tokens=res_data.get("usage", {}).get("completion_tokens", 0),
                            cost_usd=None
                        )
                    )
            except urllib.error.HTTPError as e:
                if e.code in (429, 503) and attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                err = e.read().decode("utf-8", "replace")
                raise provider_error(f"OpenAI: HTTP {e.code}: {err}") from e
            except urllib.error.URLError as e:
                raise provider_error(f"OpenAI: không kết nối được: {e.reason}") from e
            except (KeyError, IndexError, ValueError) as e:
                raise provider_error(f"OpenAI: response không đúng định dạng: {e}") from e

    def _call_gemini_api(self, params: Dict[str, Any]):
        api_key = self._get_api_key("GEMINI_API_KEY")
        if not api_key:
            raise provider_error("Gemini: thiếu GEMINI_API_KEY")
            
        contents = []
        for msg in params.get("messages", []):
            role = "user" if msg.get("role") == "user" else "model"
            contents.append({
                "role": role,
                "parts": [{"text": self._first_text_from_msg(msg.get("content", ""))}]
            })
            
        payload = {
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": params.get("max_tokens", 8000)
            }
        }
        if params.get("system"):
            payload["systemInstruction"] = {
                "parts": [{"text": params.get("system")}]
            }
            
        output_config = params.get("output_config")
        if output_config and "format" in output_config:
            schema = output_config["format"].get("schema")
            if schema:
                # Gemini doesn't support additionalProperties in responseSchema
                def remove_additional_properties(d: Any) -> Any:
                    if isinstance(d, dict):
                        d = {k: v for k, v in d.items() if k != "additionalProperties"}
                        for k, v in d.items():
                            d[k] = remove_additional_properties(v)
                    elif isinstance(d, list):
                        d = [remove_additional_properties(i) for i in d]
                    return d
                
                clean_schema = remove_additional_properties(schema)
                payload["generationConfig"]["responseMimeType"] = "application/json"
                payload["generationConfig"]["responseSchema"] = clean_schema
                
        # Handle the actual model path which Gemini uses (without the custom suffixes for UI)
        model_str = params["model"].replace("-high", "").replace("-medium", "").replace("-low", "")
        
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_str}:generateContent?key={api_key}"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        
        max_retries = 3
        for attempt in range(max_retries):
            try:
                with urllib.request.urlopen(req) as response:
                    res_data = json.loads(response.read().decode("utf-8"))
                    text = res_data["candidates"][0]["content"]["parts"][0]["text"]
                    usage = res_data.get("usageMetadata", {})
                    return SimpleNamespace(
                        content=[SimpleNamespace(type="text", text=text)],
                        stop_reason="end_turn",
                        usage=SimpleNamespace(
                            input_tokens=usage.get("promptTokenCount", 0),
                            output_tokens=usage.get("candidatesTokenCount", 0),
                            cost_usd=None
                        )
                    )
            except urllib.error.HTTPError as e:
                if e.code in (429, 503) and attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                err = e.read().decode("utf-8", "replace")
                raise provider_error(f"Gemini: HTTP {e.code}: {err}") from e
            except urllib.error.URLError as e:
                raise provider_error(f"Gemini: không kết nối được: {e.reason}") from e
            except (KeyError, IndexError, ValueError) as e:
                raise provider_error(f"Gemini: response không đúng định dạng: {e}") from e

    @staticmethod
    def _first_text_from_msg(content: Any) -> str:
        if isinstance(content, str): return content
        if isinstance(content, list):
            for block in content:
                if getattr(block, "type", None) == "text": return block.text
                if isinstance(block, dict) and block.get("type") == "text": return block.get("text", "")
        return str(content)
