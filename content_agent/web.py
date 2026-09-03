"""Web UI local cho pipeline: nhập brief -> xem tiến trình -> đọc kết quả.

Chỉ dùng thư viện chuẩn (pip trên máy này hỏng, xem README), phục vụ ở
127.0.0.1. Mỗi lần bấm chạy sinh một tiến trình `run.py` riêng; server đọc
stdout theo dòng, phân tích thành sự kiện có cấu trúc rồi trả cho UI qua polling.
"""

from __future__ import annotations

import json
import re
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from . import notion_publish
from .brief import PLATFORMS
from .config import DEFAULT_MODEL, LIGHT_STAGES, PRICING_USD_PER_MTOK

ROOT = Path(__file__).resolve().parent.parent
UI_FILE = Path(__file__).resolve().parent / "web_ui.html"

# Nhãn hiển thị cho từng nền tảng và model, để UI không phải hardcode.
PLATFORM_LABELS = {
    "youtube_shorts": "YouTube Shorts",
    "youtube_long": "YouTube (video dài)",
    "tiktok": "TikTok",
    "reels": "Instagram Reels",
}

STEP_RE = re.compile(r"^\[(\d+)/(\d+)\]\s*(.+?)\.\.\.\s*$")
# Hậu tố " · <model>" chỉ xuất hiện khi bước đó chạy model khác mặc định.
USAGE_RE = re.compile(
    r"^\s*·\s*(\S+):\s*(\d+) in / (\d+) out \(\$?([\d.]+|n/a)\)(?:\s*·\s*(\S+))?"
)
DONE_RE = re.compile(r"^Xong -> (.+)$")  # giờ bắt link Notion, không phải đường dẫn
WARN_RE = re.compile(r"^\s*!\s*(.+)$")
RETRY_RE = re.compile(r"^\s*!\s*(\S+): output sai schema")


class Run:
    """Một lần chạy pipeline: tiến trình con + log đã phân tích."""

    def __init__(self, run_id: str, argv: List[str], brief: Dict[str, Any]) -> None:
        self.id = run_id
        self.argv = argv
        # Giữ lại brief để mở lại bằng link #run/<id> vẫn biết đang chạy cái gì.
        self.brief = brief
        self.started_at = time.time()
        self.proc: Optional[subprocess.Popen] = None
        self._stop_requested = False
        # Run thật kết thúc bằng một link Notion (không còn thư mục local nào).
        self.notion_url: Optional[str] = None
        self.events: List[Dict[str, Any]] = []
        self.status = "running"
        self.error: Optional[str] = None
        self.result: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()

    def _add(self, event: Dict[str, Any]) -> None:
        with self._lock:
            self.events.append(event)

    def snapshot(self, since: int = 0) -> Dict[str, Any]:
        with self._lock:
            return {
                "status": self.status,
                "brief": self.brief,
                "started_at": self.started_at,
                "events": self.events[since:],
                "total_events": len(self.events),
                "notion_url": self.notion_url,
                "error": self.error,
                "result": self.result,
            }

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self) -> bool:
        """Dừng tiến trình đang chạy. Trả về False nếu không có gì để dừng."""
        if self.proc is None or self.status != "running":
            return False
        self._stop_requested = True
        _terminate_process_group(self.proc)
        return True

    def _run(self) -> None:
        try:
            self.proc = subprocess.Popen(
                self.argv,
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                bufsize=1,
                universal_newlines=True,
                # Tự làm session leader: run.py gọi `claude` như tiến trình con, và
                # `claude` (Node) có thể đẻ thêm cháu. Không tách nhóm thì dừng riêng
                # run.py để lại cả cây tiến trình đó chạy tiếp, vẫn tốn hạn mức/token.
                start_new_session=True,
            )
            proc = self.proc
        except OSError as exc:
            self.status, self.error = "error", f"Không chạy được run.py: {exc}"
            return

        assert proc.stdout is not None
        for raw in proc.stdout:
            self._consume(raw.rstrip("\n"))
        proc.wait()

        if self.status == "running":
            if self._stop_requested:
                self.status = "stopped"
                self.error = "Đã dừng theo yêu cầu."
            elif proc.returncode == 0:
                # Không có link Notion nghĩa là --dry-run: chạy xong nhưng không
                # lưu ở đâu nên cũng không có gì để dựng màn kết quả.
                page_id = notion_publish.page_id_from_url(self.notion_url or "")
                if page_id:
                    try:
                        self.result = notion_publish.read_run(page_id)
                    except notion_publish.NotionPublishError as exc:
                        self.error = f"Đã lưu lên Notion nhưng đọc lại không được: {exc}"
                self.status = "done"
            else:
                self.status = "error"
                self.error = self.error or f"run.py thoát mã {proc.returncode}."

    def _consume(self, line: str) -> None:
        """Đổi một dòng stdout thành sự kiện có cấu trúc cho UI."""
        if not line.strip():
            return

        match = STEP_RE.match(line)
        if match:
            self._add({"type": "step", "index": int(match.group(1)),
                       "total": int(match.group(2)), "name": match.group(3)})
            return

        match = USAGE_RE.match(line)
        if match:
            cost = match.group(4)
            self._add({"type": "usage", "stage": match.group(1),
                       "input_tokens": int(match.group(2)),
                       "output_tokens": int(match.group(3)),
                       "cost_usd": None if cost == "n/a" else float(cost),
                       "model": match.group(5)})
            return

        match = DONE_RE.match(line)
        if match:
            self.notion_url = match.group(1).strip()
            self._add({"type": "notion", "url": self.notion_url})
            return

        if line.startswith("Dừng pipeline:"):
            self.status = "error"
            self.error = line[len("Dừng pipeline:"):].strip()
            self._add({"type": "error", "message": self.error})
            return

        match = WARN_RE.match(line)
        if match:
            kind = "retry" if RETRY_RE.match(line) else "warning"
            self._add({"type": kind, "message": match.group(1)})
            return

        # Các dòng tổng kết (title nháp, thời lượng, backend) chỉ để hiển thị thô.
        self._add({"type": "log", "message": line})


def read_output_dir(path: Path) -> Dict[str, Any]:
    """Đọc toàn bộ artifact của một lần chạy để UI dựng màn kết quả."""

    def load_json(name: str) -> Any:
        try:
            return json.loads((path / name).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def load_text(name: str) -> Optional[str]:
        try:
            return (path / name).read_text(encoding="utf-8")
        except OSError:
            return None

    try:
        rel = path.resolve().relative_to((ROOT / "output").resolve()).as_posix()
    except ValueError:
        rel = path.name

    return {
        "dir": str(path),
        "rel": rel,
        "brief": load_json("brief.json"),
        "research": load_json("research_notes.json"),
        "script": load_json("script.json"),
        "title_options": (load_json("title_options.json") or {}).get("title_options"),
        "tags": load_json("tags.json"),
        "meta": load_json("run_meta.json"),
        "description": load_text("description.txt"),
        "script_md": load_text("script.md"),
    }


# Tên thư mục bắt đầu bằng slug nên sắp xếp theo tên sẽ nhóm theo chủ đề chứ không
# theo thời gian — luôn phải tự dựng lại mốc thời gian để sắp xếp.
DATE_DIR_RE = re.compile(r"^(\d{8})$")
TIME_SUFFIX_RE = re.compile(r"-(\d{6})$")
FULL_STAMP_RE = re.compile(r"-(\d{8})-(\d{6})$")  # cấu trúc cũ, giữ để đọc lại được


def _parse(stamp: str) -> Optional[float]:
    try:
        return datetime.strptime(stamp, "%Y%m%d%H%M%S").timestamp()
    except ValueError:
        return None

def run_started_at(path: Path) -> float:
    """Mốc thời gian của một lần chạy: ngày từ thư mục cha, giờ từ tên thư mục."""
    date_match = DATE_DIR_RE.match(path.parent.name)
    time_match = TIME_SUFFIX_RE.search(path.name)
    if date_match and time_match:
        parsed = _parse(date_match.group(1) + time_match.group(1))
        if parsed is not None:
            return parsed

    full = FULL_STAMP_RE.search(path.name)
    if full:
        parsed = _parse(full.group(1) + full.group(2))
        if parsed is not None:
            return parsed

    try:  # thư mục đặt tên khác (chạy với --out) thì dựa vào mtime
        return path.stat().st_mtime
    except OSError:
        return 0.0


def list_runs(limit: int = 20) -> List[Dict[str, Any]]:
    """Lần chạy gần nhất: Notion (nguồn hiện tại) + output/ (lịch sử trước khi đổi).

    Hai nguồn không trùng nhau — run cũ chỉ có trên đĩa, run mới chỉ có trên
    Notion — nên gộp thẳng rồi sắp theo thời gian, không cần khử trùng lặp.
    """
    runs = _list_local_runs(limit)
    if notion_publish.is_configured():
        try:
            runs += notion_publish.query_recent_runs(limit)
        except notion_publish.NotionPublishError:
            pass  # mất mạng thì vẫn hiện được phần lịch sử local
    runs.sort(key=lambda r: r.get("_sort_ts") or 0, reverse=True)
    return runs[:limit]


def _list_local_runs(limit: int = 20) -> List[Dict[str, Any]]:
    """Lịch sử còn sót trên đĩa từ trước khi chuyển hẳn sang Notion."""
    root = ROOT / "output"
    if not root.is_dir():
        return []

    # output/<YYYYMMDD>/<run>/ là layout hiện tại; run nằm thẳng trong output/ là
    # layout cũ, vẫn đọc được để không mất các lần chạy trước khi đổi cấu trúc.
    candidates = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        if (entry / "run_meta.json").is_file():
            candidates.append(entry)
        else:
            candidates.extend(child for child in entry.iterdir() if child.is_dir())

    runs = []
    for path in sorted(candidates, key=run_started_at, reverse=True):
        meta_file = path / "run_meta.json"
        if not meta_file.is_file():
            continue  # run hỏng giữa chừng, không có gì để xem
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            brief = json.loads((path / "brief.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        started = datetime.fromtimestamp(run_started_at(path))
        runs.append({
            "dir": path.relative_to(root).as_posix(),
            "_sort_ts": run_started_at(path),
            "date": started.strftime("%d/%m/%Y"),
            "started": started.strftime("%H:%M"),
            "topic": brief.get("topic", path.name),
            "platform": PLATFORM_LABELS.get(brief.get("platform"), brief.get("platform")),
            "duration": brief.get("duration_target_sec"),
            "title": meta.get("working_title"),
            "backend": (meta.get("usage") or {}).get("backend"),
        })
        if len(runs) >= limit:
            break
    return runs


def build_argv(payload: Dict[str, Any]) -> Tuple[List[str], Dict[str, Any]]:
    topic = (payload.get("topic") or "").strip()
    if not topic:
        raise ValueError("Thiếu chủ đề.")

    platform = payload.get("platform") or "youtube_shorts"
    if platform not in PLATFORMS:
        raise ValueError(f"Nền tảng không hợp lệ: {platform}")

    try:
        duration = int(payload.get("duration") or 45)
    except (TypeError, ValueError):
        raise ValueError("Thời lượng phải là số giây.")
    if not 5 <= duration <= 1800:
        raise ValueError("Thời lượng nên trong khoảng 5-1800 giây.")

    # -u để stdout không bị đệm, nhờ đó tiến trình hiện lên UI theo thời gian thực.
    argv = [sys.executable, "-u", "run.py",
            "--topic", topic, "--platform", platform, "--duration", str(duration)]

    model = (payload.get("model") or "").strip()
    if model:
        argv += ["--model", model]

    light = (payload.get("light_model") or "").strip()
    if light and light != model:
        argv += ["--light-model", light]
    for field, flag in (("tone", "--tone"), ("audience", "--audience")):
        value = (payload.get(field) or "").strip()
        if value:
            argv += [flag, value]
    if payload.get("dry_run"):
        argv.append("--dry-run")

    brief = {
        "topic": topic,
        "platform": platform,
        "platform_label": PLATFORM_LABELS.get(platform, platform),
        "duration": duration,
        "model": model or DEFAULT_MODEL,
        "light_model": light if light and light != model else None,
        "dry_run": bool(payload.get("dry_run")),
    }
    return argv, brief


def _terminate_process_group(proc: subprocess.Popen) -> None:
    """SIGTERM cả nhóm tiến trình, leo thang SIGKILL nếu sau vài giây vẫn sống.

    Chạy trong thread riêng vì handler HTTP gọi `stop()` phải trả lời ngay,
    không đợi tiến trình con thoát hẳn.
    """
    def escalate() -> None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, AttributeError):
            proc.terminate()
            return
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    threading.Thread(target=escalate, daemon=True).start()


RUNS: Dict[str, Run] = {}


class Handler(BaseHTTPRequestHandler):
    server_version = "ContentAgentUI"

    def log_message(self, fmt: str, *args) -> None:  # bớt ồn ở terminal
        return

    # ---------- helper ----------

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload: Any, code: int = 200) -> None:
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    # ---------- routes ----------

    def do_GET(self) -> None:
        route = urlparse(self.path)
        if route.path in ("/", "/index.html"):
            try:
                self._send(200, UI_FILE.read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"Thieu web_ui.html", "text/plain; charset=utf-8")
            return

        if route.path == "/api/options":
            self._json({
                "light_stages": list(LIGHT_STAGES),
                "platforms": [{"value": p, "label": PLATFORM_LABELS.get(p, p)} for p in PLATFORMS],
                "models": [{"value": m, "label": m,
                            "price": f"${i:g}/${o:g} mỗi 1M token"}
                           for m, (i, o) in PRICING_USD_PER_MTOK.items()],
                "default_model": DEFAULT_MODEL,
                "default_duration": 45,
            })
            return

        if route.path == "/api/runs":
            self._json({"runs": list_runs()})
            return

        if route.path == "/api/result":
            params = parse_qs(route.query)

            page_id = (params.get("page_id") or [""])[0]
            if page_id:
                try:
                    result = notion_publish.read_run(page_id)
                except notion_publish.NotionPublishError as exc:
                    self._json({"error": str(exc)}, 502)
                    return
                if result is None:
                    self._json({"error": "Trang Notion này không có khối JSON gốc."}, 404)
                    return
                self._json(result)
                return

            name = (params.get("dir") or [""])[0]
            target = (ROOT / "output" / name).resolve()
            # Chỉ cho đọc bên trong output/ (kể cả lồng trong thư mục ngày),
            # chặn mọi đường đi ngược ra ngoài bằng "../".
            if not name or (ROOT / "output").resolve() not in target.parents:
                self._json({"error": "Thư mục không hợp lệ."}, 400)
                return
            if not (target / "run_meta.json").exists():
                self._json({"error": "Lần chạy này không có run_meta.json."}, 404)
                return
            self._json(read_output_dir(target))
            return

        if route.path == "/api/status":
            params = parse_qs(route.query)
            run = RUNS.get((params.get("id") or [""])[0])
            if run is None:
                self._json({"error": "Không tìm thấy lần chạy này."}, 404)
                return
            since = int((params.get("since") or ["0"])[0])
            self._json(run.snapshot(since))
            return

        self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        route = urlparse(self.path).path
        if route not in ("/api/run", "/api/stop"):
            self._json({"error": "not found"}, 404)
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            self._json({"error": str(exc)}, 400)
            return

        if route == "/api/stop":
            self.do_POST_stop(payload)
            return

        try:
            argv, brief = build_argv(payload)
        except ValueError as exc:
            self._json({"error": str(exc)}, 400)
            return

        run = Run(uuid.uuid4().hex[:12], argv, brief)
        RUNS[run.id] = run
        run.start()
        self._json({"run_id": run.id, "command": " ".join(argv)})

    def do_POST_stop(self, payload: Dict[str, Any]) -> None:
        run = RUNS.get(payload.get("id") or "")
        if run is None:
            self._json({"error": "Không tìm thấy lần chạy này."}, 404)
            return
        stopped = run.stop()
        self._json({"stopped": stopped, "status": run.status})


def serve(host: str = "127.0.0.1", port: int = 8765) -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Content Agent UI: http://{host}:{port}  (Ctrl+C để dừng)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nĐã dừng.")
    finally:
        httpd.server_close()
