# Content Agent — MVP

Từ một chủ đề, agent tự research (có web search), viết kịch bản theo ngân sách
thời gian, rồi sinh title/description/tags. Thiết kế đầy đủ ở [SPEC.md](SPEC.md);
bản này là MVP v0.1 — chỉ **Research → Script → Metadata**, chưa có B-roll Agent
và chưa tách Outline Agent riêng (script agent tự chia section).

## Cài đặt

Máy này là Ubuntu 20.04 / Python 3.8, nên `pip` chỉ cài được `anthropic` 0.72
(bản 1.x cần Python ≥ 3.10). Code chạy được cả hai: [llm.py](content_agent/llm.py)
tự phát hiện SDK có `output_config` native hay không và fallback sang `extra_body`.

```bash
python3 -m venv --without-pip .venv
pip3 install --target .venv/lib/python3.8/site-packages -r requirements.txt
cp .env.example .env
```

## Hai backend

Mặc định pipeline **không gọi Messages API**: nó chạy qua Claude Code headless
(`claude -p`), tức dùng hạn mức gói thuê bao Claude Code và không tốn credit API.
Cần cài sẵn `claude` trong PATH.

Đặt `CONTENT_AGENT_USE_API=true` trong `.env` để quay lại gọi thẳng Messages API —
khi đó mới cần `ANTHROPIC_API_KEY` (và `ANTHROPIC_WORKSPACE_ID` nếu key gắn với
identity, API sẽ báo `anthropic-workspace-id is required` nếu thiếu).

Biến môi trường đã export sẵn luôn thắng file `.env`.

Đường CLI có vài điểm khác, [claude_cli.py](content_agent/claude_cli.py) đã xử lý:
structured output đi qua cờ `--json-schema`; web search là tool phía client của
Claude Code nên không có `pause_turn`; `--safe-mode` chặn CLAUDE.md/skills của
repo lọt vào ngữ cảnh agent; mọi tool đụng tới file đều bị chặn. Con số chi phí
in ra ở cuối là **giá quy đổi nếu gọi API**, không phải tiền bị trừ.

## Đẩy kết quả lên Notion (tuỳ chọn)

Mỗi lần chạy thật (không phải `--dry-run`) có thể tự đẩy một page vào một
database Notion — page có đủ kịch bản theo timeline, ghi chú nghiên cứu kèm
nguồn bấm được, và metadata; các cột số/chọn (nền tảng, chi phí, backend,
tags...) map vào property của database để lọc/sắp xếp được.

```bash
cp .env.example .env
# điền NOTION_TOKEN và NOTION_DATA_SOURCE_ID — cần cả hai mới kích hoạt
```

1. Tạo integration tại notion.so/my-integrations, copy token.
2. Mở database đích trong Notion → "..." → Connections → thêm integration đó
   (thiếu bước này thì API trả 404 dù token đúng).

Thiếu một trong hai biến thì pipeline bỏ qua bước này hoàn toàn, không cảnh
báo, không lỗi. Có cấu hình rồi mà một lần chạy cụ thể không muốn đẩy: thêm
`--no-notion`. Đẩy thất bại (mạng, token sai, database chưa share) chỉ thành
một dòng cảnh báo — output local đã ghi xong trước đó nên không mất gì.

`content_agent/notion_publish.py` chỉ dùng `urllib` (thư viện chuẩn), không
thêm dependency — máy này pip đang hỏng nên giữ nguyên tắc như `web.py`.

## Giao diện web

```bash
.venv/bin/python serve.py            # mở http://127.0.0.1:8765
```

Nhập chủ đề, chọn nền tảng / thời lượng (bỏ trống = 45 giây) / model rồi bấm chạy;
màn tiếp theo hiện tiến trình từng bước với token và chi phí của mỗi lượt gọi, xong
thì dựng kết quả thành kịch bản có timeline, metadata, và danh sách nguồn bấm được.
Trang cũng liệt kê các lần chạy trước, nhóm theo ngày, để mở lại.

Server chỉ dùng thư viện chuẩn ([web.py](content_agent/web.py) +
[web_ui.html](content_agent/web_ui.html)), bind vào 127.0.0.1, và mỗi lần bấm chạy
là một tiến trình `run.py` riêng — UI đọc stdout của nó chứ không gọi model trực tiếp.
Link có dạng `#run/<id>` (đang chạy) và `#result/<YYYYMMDD%2Frun>/<tab>` (kết quả cũ)
nên F5 hay chia sẻ link đều không mất chỗ đang xem.

Output ghi vào `output/<YYYYMMDD>/<slug>-<HHMMSS>/` — ngày ở thư mục cha, tên run
chỉ mang giờ. Server vẫn đọc được các cấu trúc cũ (run nằm thẳng trong `output/`,
hoặc tên run mang đủ `YYYYMMDD-HHMMSS`).

## Chạy bằng dòng lệnh

```bash
# Chạy thử toàn bộ pipeline bằng dữ liệu giả, không gọi API, không tốn tiền
.venv/bin/python run.py --topic "Vì sao mèo sợ dưa chuột?" --dry-run

# Chạy thật
.venv/bin/python run.py --topic "Vì sao mèo sợ dưa chuột?" --platform tiktok --duration 45

# Brief đầy đủ từ file JSON (mọi trường trong VideoBrief)
.venv/bin/python run.py --brief brief.json
```

Tuỳ chọn khác: `--tone`, `--audience`, `--language`, `--must-include` (lặp được),
`--avoid` (lặp được), `--model`, `--max-tokens`, `--out`, `--quiet`.

Model mặc định là `claude-opus-5`. Muốn rẻ hơn: `--model claude-sonnet-5` (hoặc
đặt `CONTENT_AGENT_MODEL`). Với model không hỗ trợ web search bản mới hay
`effort`, code tự hạ xuống biến thể cơ bản.

### Chọn model theo từng bước

Pipeline có 4 lượt gọi. `research.search` và `script` cần suy luận thật;
`research.structure` (ghi chú → JSON) và `metadata` (kịch bản → title/tag) chỉ
biến đổi dữ liệu có sẵn nên hạ model được:

```bash
# Hai bước phụ chạy Haiku, hai bước chính giữ Sonnet
.venv/bin/python run.py --topic "..." --model claude-sonnet-5 --light-model claude-haiku-4-5

# Chỉ định từng bước một (lặp được, thắng --light-model khi trùng)
.venv/bin/python run.py --topic "..." --stage-model script=claude-opus-5
```

Bước nào chạy model khác mặc định thì dòng log ghi kèm tên model, và `run_meta.json`
lưu lại bản đồ trong `usage.stage_models`. Trên UI đây là ô "Model bước phụ".

## Output

Mỗi lần chạy tạo `output/<slug-chủ-đề>-<timestamp>/`:

| File | Nội dung |
|---|---|
| `script.md` | Kịch bản để cầm đi quay: timestamp, lời thoại, gợi ý hình ảnh, nguồn |
| `description.txt` | Description + hashtag, kèm các phương án title khác |
| `tags.json` | `tags` + `hashtags` |
| `title_options.json` | 3–5 phương án title |
| `research_notes.json` | Fact + URL nguồn + độ tin cậy, để trace lại claim trong script |
| `script.json` | Script dạng có cấu trúc (input cho B-roll Agent ở v0.3) |
| `brief.json`, `run_meta.json` | Brief đã dùng; token/chi phí/cảnh báo của lần chạy |

## Kiến trúc

```
run.py → cli.py → pipeline.py
                    ├─ agents/research.py   2 lời gọi: web search → JSON hoá
                    ├─ agents/script.py     1 lời gọi structured output
                    ├─ agents/metadata.py   1 lời gọi structured output
                    ├─ timeline.py          cộng dồn timestamp, đối chiếu thời lượng
                    └─ render.py            script.md, description.txt
```

Vài quyết định đáng chú ý:

- **Timestamp do code tính, không do model.** Model chỉ đưa `duration_sec` mỗi
  section; `timeline.py` cộng dồn và ước lượng thời lượng đọc thật từ số âm tiết
  (2.5 âm tiết/giây cho tiếng Việt), rồi cảnh báo nếu lệch quá 15% so với mục tiêu.
- **Research tách làm hai lời gọi.** Lời gọi có web search trả text (server tool
  có thể `pause_turn` giữa chừng — `llm.py` nối lượt và gọi tiếp), lời gọi thứ hai
  ép sang JSON. Tách ra thì rẻ và ổn định hơn gộp một.
- **Structured output + retry.** Mọi stage trả JSON đều gửi kèm JSON Schema strict
  sinh từ pydantic; sai schema thì retry tối đa 2 lần rồi dừng hẳn, không đoán bừa.
- **Gate chất lượng.** Cảnh báo khi >30% fact có độ tin cậy thấp, khi fact thiếu
  URL nguồn, và khi lời thoại vượt ngân sách giây của section.

## Chưa có

B-roll Agent, Outline Agent tách riêng + checkpoint duyệt outline, TTS, dựng
video. Roadmap ở [SPEC.md §6](SPEC.md).
