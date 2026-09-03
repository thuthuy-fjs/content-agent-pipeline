"""Backend chạy qua Claude Code headless (`claude -p`) thay cho Messages API.

Dùng hạn mức gói thuê bao Claude Code, không tiêu credit API. Lớp
`ClaudeCodeClient` giả lập đúng bề mặt `client.messages.create(**params)` mà
`ClaudeRunner` cần, nên toàn bộ phần retry schema / đếm usage ở llm.py dùng lại
được nguyên vẹn.

Khác biệt so với đường API, đã tính trước:
- Structured output đi qua cờ `--json-schema`, CLI trả JSON trong `result`.
- Web search là tool phía client của Claude Code (`WebSearch`), không phải server
  tool, nên không bao giờ có `pause_turn`.
- Mỗi lần gọi là một tiến trình mới: không có state giữa các lượt, cả hội thoại
  được ghép lại thành một prompt.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

CLI_BINARY = os.environ.get("CONTENT_AGENT_CLAUDE_BIN", "claude")
DEFAULT_TIMEOUT_SEC = int(os.environ.get("CONTENT_AGENT_CLI_TIMEOUT", "900"))

# Chỉ mở đúng tool cần dùng; phần còn lại chặn thẳng để một lần chạy pipeline
# không thể đụng vào file trong repo.
BLOCKED_TOOLS = [
    "Bash", "Edit", "Write", "Read", "Glob", "Grep",
    "NotebookEdit", "WebFetch", "Task", "TodoWrite",
]

# Backend này tồn tại để dùng hạn mức thuê bao. Nếu để `claude` nhìn thấy
# ANTHROPIC_API_KEY mà dotenv vừa nạp, nó sẽ xác thực bằng key đó thay vì OAuth —
# và key gắn với identity thì `claude` không gửi header workspace, nên API trả 400.
INHERITED_CREDENTIALS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_WORKSPACE_ID")


def _subprocess_env() -> Dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in INHERITED_CREDENTIALS}


class ClaudeCLIError(RuntimeError):
    """Lỗi khi gọi `claude -p`."""


def _render_messages(messages: List[dict]) -> str:
    """Ghép hội thoại thành một prompt duy nhất.

    Lượt đầu tiên chiếm đa số trường hợp; nhiều lượt chỉ xảy ra ở vòng retry
    schema của `ClaudeRunner.structured`.
    """
    if len(messages) == 1:
        return _content_to_text(messages[0].get("content", ""))

    parts = []
    for message in messages:
        role = "NGƯỜI DÙNG" if message.get("role") == "user" else "TRỢ LÝ"
        parts.append(f"[{role}]\n{_content_to_text(message.get('content', ''))}")
    return "\n\n".join(parts)


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for block in content:
            text = block.get("text") if isinstance(block, dict) else getattr(block, "text", None)
            if text:
                chunks.append(text)
        return "\n".join(chunks)
    return str(content)


def _needs_web_search(tools: Optional[List[dict]]) -> bool:
    return any("web_search" in (t.get("type", "") + t.get("name", "")) for t in tools or [])


class ClaudeCodeMessages:
    def __init__(self, timeout_sec: int = DEFAULT_TIMEOUT_SEC) -> None:
        self.timeout_sec = timeout_sec

    def create(self, **params):
        config = params.get("output_config") or params.get("extra_body", {}).get(
            "output_config", {}
        )
        schema = (config.get("format") or {}).get("schema")

        argv = [
            CLI_BINARY, "-p", _render_messages(params.get("messages", [])),
            "--output-format", "json",
            # Không để CLAUDE.md / skills / hooks của repo lọt vào ngữ cảnh agent.
            "--safe-mode",
            # Bỏ phần liệt kê skill khỏi system prompt: đo được ~3.4k token/lượt.
            "--disable-slash-commands",
            "--no-session-persistence",
            "--model", params["model"],
        ]
        if params.get("system"):
            argv += ["--system-prompt", params["system"]]
        if schema:
            argv += ["--json-schema", json.dumps(schema, ensure_ascii=False)]
        if config.get("effort"):
            argv += ["--effort", config["effort"]]
        if _needs_web_search(params.get("tools")):
            argv += ["--allowed-tools", "WebSearch"]
        argv += ["--disallowed-tools"] + BLOCKED_TOOLS

        payload = self._run(argv)
        if payload.get("is_error"):
            _dump_debug(argv, payload)
            raise ClaudeCLIError(_error_message(payload))

        return _to_response(payload)

    def _run(self, argv: List[str]) -> Dict[str, Any]:
        if shutil.which(CLI_BINARY) is None:
            raise ClaudeCLIError(
                f"Không tìm thấy lệnh `{CLI_BINARY}`. Cài Claude Code, hoặc đặt "
                "CONTENT_AGENT_USE_API=true trong .env để dùng Messages API."
            )
        try:
            proc = subprocess.run(
                argv,
                env=_subprocess_env(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.timeout_sec,
            )
        except subprocess.TimeoutExpired as exc:
            raise ClaudeCLIError(
                f"`claude -p` quá {self.timeout_sec}s. Tăng CONTENT_AGENT_CLI_TIMEOUT."
            ) from exc

        stdout = proc.stdout.decode("utf-8", "replace").strip()
        stderr = proc.stderr.decode("utf-8", "replace").strip()

        # Khi hỏng, `claude -p` thoát khác 0 NHƯNG vẫn in JSON chẩn đoán ra stdout;
        # lý do thật nằm ở đó chứ không phải stderr. Parse trước, xét mã thoát sau.
        try:
            return json.loads(stdout)
        except json.JSONDecodeError:
            pass

        detail = stderr or stdout or "không có output nào"
        raise ClaudeCLIError(f"`claude -p` thoát mã {proc.returncode}: {detail[:800]}")


def _dump_debug(argv: List[str], payload: Dict[str, Any]) -> None:
    """CONTENT_AGENT_DEBUG=1: ghi lại argv + payload để mổ xẻ lỗi khó lặp lại."""
    path = os.environ.get("CONTENT_AGENT_DEBUG_FILE")
    if not (os.environ.get("CONTENT_AGENT_DEBUG") or path):
        return
    path = path or "claude_cli_debug.json"
    with open(path, "a", encoding="utf-8") as handle:
        json.dump({"argv": argv, "payload": payload}, handle, ensure_ascii=False)
        handle.write("\n")


def _error_message(payload: Dict[str, Any]) -> str:
    """Gom các trường lỗi của `claude -p` thành một câu đọc được."""
    parts = [payload.get("result") or "`claude -p` báo lỗi không kèm mô tả."]
    reason = payload.get("terminal_reason")
    status = payload.get("api_error_status")
    if reason:
        parts.append(f"(terminal_reason={reason}"
                     + (f", HTTP {status}" if status else "") + ")")
    denials = payload.get("permission_denials")
    if denials:
        parts.append(f"Tool bị chặn: {denials}")
    return " ".join(parts)


def _to_response(payload: Dict[str, Any]):
    """Đổi output của CLI sang hình dạng response mà ClaudeRunner đọc được."""
    usage = payload.get("usage") or {}
    # input_tokens của CLI không tính phần cache; cộng lại để con số báo cáo
    # phản ánh đúng lượng ngữ cảnh đã gửi đi.
    input_tokens = (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
    )
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=payload.get("result") or "")],
        # `claude -p` chỉ trả về khi đã xong lượt, nên không có pause_turn.
        stop_reason="end_turn",
        usage=SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=int(usage.get("output_tokens") or 0),
            # CLI tự báo chi phí quy đổi; với gói thuê bao đây là số tham khảo,
            # không phải tiền bị trừ.
            cost_usd=payload.get("total_cost_usd"),
        ),
    )


class ClaudeCodeClient:
    """Đứng ở đúng chỗ của `anthropic.Anthropic()` trong ClaudeRunner."""

    def __init__(self, timeout_sec: int = DEFAULT_TIMEOUT_SEC) -> None:
        self.messages = ClaudeCodeMessages(timeout_sec)
