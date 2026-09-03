# Spec: Content Agent — Pipeline sản xuất video tự động

## 1. Mục tiêu & phạm vi

**Input:** một chủ đề (topic) do người dùng nhập, kèm vài tham số tuỳ chọn.
**Output:** một bộ tài liệu sẵn sàng để quay/dựng:
- Script đầy đủ (lời thoại + cue hình ảnh theo timestamp)
- Outline/cấu trúc video
- Danh sách gợi ý B-roll/hình ảnh cho từng đoạn
- Title, description, tags/hashtags

**Không làm trong scope này:** tự quay, tự dựng, tự tạo giọng đọc (TTS) hay video thật — pipeline dừng ở mức "tài liệu sản xuất", con người vẫn là người quay/dựng cuối cùng. Các phần này để ở mục Mở rộng (§8).

Analogy: agent đóng vai producer nội bộ — nhận brief ngắn, tự nghiên cứu, tự viết kịch bản nháp, tự chuẩn bị moodboard hình ảnh, rồi giao lại "package" cho người quay hoàn thiện.

---

## 2. Input schema

```json
{
  "topic": "Vì sao mèo sợ dưa chuột?",
  "platform": "youtube_shorts | youtube_long | tiktok | reels",
  "duration_target_sec": 60,
  "tone": "hài hước | trang trọng | giáo dục | truyền cảm hứng",
  "audience": "gen Z Việt Nam quan tâm thú cưng",
  "language": "vi",
  "constraints": {
    "must_include": ["1 nguồn khoa học", "1 câu hỏi mở đầu"],
    "avoid": ["thông tin chưa kiểm chứng", "nội dung nhạy cảm"]
  }
}
```

Chỉ `topic` là bắt buộc; các trường còn lại có default (vd: `duration_target_sec: 60`, `tone: giáo dục nhẹ nhàng`, `language: vi`).

---

## 3. Kiến trúc pipeline (5 stage tuần tự, có thể chạy 1 phần song song)

```
Topic
  │
  ▼
[1] Research Agent  ──► research_notes.json
  │
  ▼
[2] Outline Agent   ──► outline.json
  │
  ▼
[3] Script Agent    ──► script.md
  │
  ├──────────────► [4] B-roll Agent ──► broll_list.csv   (chạy song song với 5, cùng đọc script.md)
  │
  ▼
[5] Metadata Agent  ──► description.txt, tags.json, title_options.json
  │
  ▼
[6] Packager        ──► xuất thư mục output/ hoàn chỉnh
```

Mỗi stage là một lời gọi LLM riêng biệt với system prompt/role riêng, nhận output JSON của bước trước làm input — không để một agent "ôm" toàn bộ việc trong 1 prompt lớn, vì:
- Dễ retry/patch từng bước khi lỗi mà không phải chạy lại toàn bộ.
- Dễ chèn checkpoint cho người dùng duyệt giữa các bước (human-in-the-loop).
- Dễ tinh chỉnh riêng chất lượng từng bước (research cần fact-check, script cần văn phong).

### 3.1 Stage 1 — Research Agent
- **Việc làm:** web search chủ đề, thu thập 5–10 fact/insight đáng chú ý, mỗi fact kèm nguồn (URL) và độ tin cậy tự đánh giá.
- **Công cụ cần:** web search tool (WebSearch/WebFetch), không dùng kiến thức nội tại không kiểm chứng cho số liệu/claim cụ thể.
- **Output schema:**
```json
{
  "facts": [
    {"claim": "...", "source_url": "...", "confidence": "high|medium|low"}
  ],
  "angle_suggestions": ["góc kể chuyện A", "góc kể chuyện B"],
  "hook_ideas": ["câu mở đầu gây tò mò 1", "..."]
}
```
- **Guard:** nếu không tìm được nguồn đáng tin, đánh dấu `confidence: low` và Script Agent ở bước sau phải né dùng claim đó như sự thật khẳng định.

### 3.2 Stage 2 — Outline Agent
- **Input:** `research_notes.json` + tham số `duration_target_sec`, `tone`.
- **Việc làm:** chọn 1 angle, dựng cấu trúc video theo block thời gian (hook → thân bài 2-4 đoạn → CTA), ước lượng số giây mỗi block dựa trên tốc độ đọc trung bình (~2.5 từ/giây tiếng Việt nói).
- **Output schema:**
```json
{
  "structure": [
    {"section": "hook", "duration_sec": 5, "goal": "gây tò mò bằng câu hỏi"},
    {"section": "point_1", "duration_sec": 15, "goal": "..."},
    {"section": "cta", "duration_sec": 5, "goal": "kêu gọi follow"}
  ]
}
```

### 3.3 Stage 3 — Script Agent
- **Input:** `outline.json` + `research_notes.json`.
- **Việc làm:** viết lời thoại đầy đủ theo từng section, đúng tone/audience, bám sát ngân sách thời gian đã chia. Với mỗi câu/đoạn, gắn timestamp ước tính và 1 gợi ý hình ảnh ngắn (visual cue) — đây là input thô cho Stage 4.
- **Output format (script.md):**
```markdown
# Script: Vì sao mèo sợ dưa chuột?

## [00:00–00:05] Hook
**Lời thoại:** "Bạn có biết vì sao mèo nhà bạn nhảy dựng lên khi thấy quả dưa chuột không?"
**Visual cue:** cận cảnh mèo giật mình, slow-motion

## [00:05–00:20] Point 1
**Lời thoại:** ...
**Visual cue:** ...
```
- **Ràng buộc chất lượng:** không bịa số liệu; claim cụ thể phải trace được về `research_notes.json`.

### 3.4 Stage 4 — B-roll / Visual Suggestion Agent
- **Input:** `script.md` (đọc các `Visual cue`).
- **Việc làm:** với mỗi đoạn, sinh ra:
  - 3–5 từ khoá tìm stock footage/ảnh (tiếng Anh, để dùng trực tiếp trên Pexels/Storyblocks/Unsplash).
  - Gợi ý loại shot (close-up, wide, screen recording, text overlay, chart...).
  - Ghi chú nếu cần B-roll tự quay thay vì stock.
- **Output (broll_list.csv):**
```
timestamp,section,search_keywords,shot_type,note
00:00-00:05,hook,"scared cat cucumber slow motion",close-up,ưu tiên footage có sẵn
00:05-00:20,point_1,"cat brain amygdala illustration",graphic overlay,cần tự làm motion graphic
```

### 3.5 Stage 5 — Metadata Agent
- **Input:** `script.md` + `outline.json` + topic gốc.
- **Việc làm:** sinh 3–5 phương án title (tối ưu theo platform: Shorts/TikTok ưu tiên tò mò, YouTube dài ưu tiên SEO), 1 description (có timestamp cho video dài, có hashtag cho Shorts/TikTok), danh sách tags/hashtags xếp theo độ liên quan.
- **Output:**
```json
{
  "title_options": ["...", "..."],
  "description": "...",
  "tags": ["mèo", "khoa học thú cưng", "..."],
  "hashtags": ["#meo", "#thuvicungthu"]
}
```

### 3.6 Stage 6 — Packager
- Gom toàn bộ output vào 1 thư mục: `output/<slug-topic>-<timestamp>/`
  - `script.md`, `outline.json`, `research_notes.json`, `broll_list.csv`, `description.txt`, `tags.json`, `title_options.json`
- Không cần agent riêng — code thuần (script Python/Node) đọc các JSON/MD trung gian và ghi ra file.

---

## 4. Orchestration & lỗi

- **Tuần tự bắt buộc:** 1 → 2 → 3. Từ 3 có thể chạy 4 và 5 song song vì cả hai chỉ đọc `script.md`.
- **Checkpoint cho người dùng (tuỳ chọn, khuyến nghị bật ở MVP):** dừng lại sau Stage 2 (outline) để người dùng duyệt hướng đi trước khi viết script đầy đủ — tránh viết cả script rồi mới phát hiện sai hướng.
- **Retry:** nếu 1 stage lỗi (vd. JSON không parse được), retry tối đa 2 lần với prompt nhắc lại đúng schema; nếu vẫn lỗi, dừng pipeline và trả lỗi rõ ràng thay vì đoán bừa.
- **Fact-check gate:** sau Stage 1, nếu >30% facts có `confidence: low`, cảnh báo người dùng trước khi tiếp tục.

---

## 5. Tech stack đề xuất

| Thành phần | Lựa chọn |
|---|---|
| LLM | Claude, mặc định `claude-opus-5`; hạ xuống `claude-sonnet-5` qua `--model` nếu cần rẻ hơn. Tinh chỉnh chi phí bằng `output_config.effort` theo từng stage (research/script: high, JSON hoá: low, metadata: medium) thay vì đổi model. |
| Web search | Server tool `web_search` của chính Messages API — không cần API search riêng |
| Orchestration | Bắt đầu đơn giản: 1 script Python tuần tự gọi API theo thứ tự stage, lưu state ra file JSON giữa các bước (dễ debug, dễ resume). Không cần framework agent phức tạp (LangGraph...) cho MVP. |
| Output | File hệ thống (JSON/MD/CSV) trong thư mục `output/` — sau này có thể đẩy lên Notion/Google Drive nếu cần chia sẻ nhóm. |

---

## 6. Roadmap triển khai (MVP → mở rộng)

1. **MVP (v0.1) — đã triển khai** (xem [README.md](README.md)): Research Agent + Script Agent + Metadata Agent, chạy tuần tự, output ra `script.md` + `description.txt` + `tags.json`. Chưa có B-roll, chưa tách outline riêng (gộp vào script prompt).
2. **v0.2:** Tách Outline Agent riêng + thêm checkpoint duyệt outline.
3. **v0.3:** Thêm B-roll Agent + fact-check confidence gate.
4. **v0.4:** Packager tự động, CLI nhận topic qua argument (`python run.py --topic "..." --platform tiktok`).
5. **v1.0+ (mở rộng, ngoài scope hiện tại):** tích hợp TTS sinh voice-over nháp, tự tải stock footage theo keyword, tự ghép rough-cut video bằng ffmpeg.

---

## 7. Tiêu chí thành công

- Từ 1 dòng topic, pipeline chạy hết không cần can thiệp thủ công (trừ checkpoint duyệt outline nếu bật) trong < 3 phút.
- Script bám đúng ngân sách thời gian outline đã chia (sai lệch < 15%).
- Không có claim cụ thể nào trong script thiếu nguồn trace được về research_notes.
- Output đủ để một người quay/dựng có thể bắt tay làm ngay, không cần hỏi lại "vậy quay cảnh gì đây".

---

## 8. Ngoài phạm vi (ghi chú cho tương lai)

- Tự động hoá TTS, dựng video, tạo thumbnail — cần pipeline riêng nối tiếp sau spec này.
- Đa ngôn ngữ đồng thời (sinh script song song vi/en) — thêm được bằng cách tham số hoá `language` và chạy Stage 3+5 nhiều lần.
- Lịch đăng bài tự động — thuộc về layer publishing, không phải content generation.
