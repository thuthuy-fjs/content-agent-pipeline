# Content Agent — MVP

Từ một chủ đề, agent tự research (có web search), viết kịch bản theo ngân sách
thời gian, rồi sinh title/description/tags. Thiết kế đầy đủ ở [SPEC.md](SPEC.md);
bản này là MVP v0.1 — chỉ **Research → Script → Metadata**, chưa có B-roll Agent
và chưa tách Outline Agent riêng (script agent tự chia section).

Chạy trên **Cloudflare Workers** (TypeScript), lưu trạng thái run trong **Workers
KV**, kết quả đẩy thẳng lên **Notion**. Không cần Durable Objects nên nằm gọn
trong Workers Free plan.

## Cấu hình

Secret chia làm hai nơi tách biệt:

| Môi trường | Nguồn secret |
|---|---|
| `wrangler dev` cục bộ | File `.dev.vars` ở thư mục gốc |
| Bản deploy thật | `wrangler secret put <TÊN>` (lưu trên Cloudflare) |

```bash
cp .dev.vars.example .dev.vars   # rồi điền giá trị thật

# Cho bản deploy:
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DATA_SOURCE_ID
npx wrangler secret put ANTHROPIC_API_KEY   # hoặc GEMINI_API_KEY / OPENAI_API_KEY
```

Sửa `.dev.vars` **không** ảnh hưởng bản deploy và ngược lại — đây là chỗ dễ nhầm
nhất: `wrangler secret put` xong mà chạy local vẫn báo thiếu key là vì vậy.

Có key model nào thì UI hiện đúng nền tảng đó; có từ 2 nền tảng trở lên mới hiện
ô chọn "Nền tảng LLM". Đổi model mặc định bằng biến `CONTENT_AGENT_MODEL` trong
`wrangler.toml`.

## Chạy local

**Máy này (Ubuntu 20.04, glibc 2.31) không chạy được `npm run dev` trực tiếp** —
`workerd`, runtime của `wrangler dev`, cần glibc ≥ 2.35. Chạy trong container base
mới hơn thay vào đó:

```bash
docker compose up                                # → http://localhost:8787
```

Lần đầu container tự `npm install` vào volume riêng (không đụng `node_modules` của
host); các lần sau bỏ qua bước đó. KV được Miniflare giả lập cục bộ, không đụng dữ
liệu KV thật trên Cloudflare.

Máy nào glibc đủ mới (Ubuntu 22.04+, macOS…) thì dùng thẳng:

```bash
npm install
npm run dev
```

Tick **"Chạy thử (dữ liệu giả, không gọi model)"** để chạy toàn bộ pipeline qua
[src/llm/fake.ts](src/llm/fake.ts) — kiểm tra đường schema/packaging mà không tốn
API quota và không cần Notion.

## Deploy

```bash
npm run deploy          # chạy thẳng trên host, không cần Docker
npx wrangler tail       # xem log, gồm cả các dòng "[provider] ..."
```

`wrangler deploy` chỉ bundle bằng esbuild rồi upload nên không đụng tới `workerd`,
không dính ràng buộc glibc ở trên.

## Notion là nơi lưu duy nhất

Pipeline **không ghi bất kỳ file nào xuống đĩa** — Workers cũng không có đĩa để
ghi. Mỗi lần chạy thật tạo một page trong database Notion; UI đọc ngược từ đó.

1. Tạo integration tại notion.so/my-integrations, copy token.
2. Mở database đích → "..." → Connections → thêm integration đó (thiếu bước này
   API trả 404 dù token đúng).
3. `NOTION_DATA_SOURCE_ID` là **data source id**, không phải id trong URL trang —
   hai thứ này khác nhau và dễ nhầm.

Thiếu cấu hình thì run thật bị **chặn ngay từ đầu**, trước khi gọi model, để không
đốt hạn mức rồi mới phát hiện không có chỗ lưu.

Mỗi page có hai phần: phần người đọc (kịch bản theo timeline, nguồn bấm được,
metadata) và một khối `code` chứa **JSON gốc**. UI đọc lại từ khối JSON đó chứ
không parse ngược block trình bày — block trình bày là bản dịch một chiều (độ tin
cậy thành màu chữ, timestamp thành tiêu đề) nên parse ngược sẽ mất dữ liệu và vỡ
khi ai đó sửa tay trang Notion. Chạm trần 100 block thì block trình bày bị cắt
trước, khối JSON gốc không bao giờ bị hy sinh.

**Rủi ro cần biết:** không còn bản local nào để lùi về. Nếu đẩy Notion thất bại
giữa chừng, toàn bộ JSON gốc được ghi vào event log của run (xem được qua
`/api/status`) để copy lại thủ công trước khi báo lỗi — đó là lớp cứu vãn cuối cùng.

Chế độ chạy thử không lưu ở đâu cả (không đĩa, không Notion): vẫn dùng để kiểm tra
đường code và schema, nhưng không xem được nội dung mẫu.

## Giao diện web

Nhập chủ đề, chọn nền tảng / thời lượng (số + đơn vị giây hoặc phút, bỏ trống = 45
giây) / model rồi bấm chạy; màn tiếp theo hiện tiến trình từng bước, xong thì dựng
kết quả thành kịch bản có timeline, metadata, và danh sách nguồn bấm được.

Nút "Lần chạy trước" mở một trang riêng: lọc theo ngày (giờ VN, UTC+7) và nền
tảng, 20 bản ghi mỗi trang; bấm vào một dòng để mở lại kết quả từ Notion.

Link có dạng `#run/<id>` (đang chạy) và `#result/n%3A<page_id>/<tab>` (kết quả cũ)
nên F5 hay chia sẻ link đều không mất chỗ đang xem. Đóng tab giữa chừng cũng không
huỷ run — pipeline chạy tiếp trong `ctx.waitUntil()`, mở lại ở mục "Đang chạy".

Nút **Dừng** là best-effort: nó bật cờ `stopRequested` trong KV, runner kiểm tra cờ
đó trước mỗi lượt gọi model rồi thoát sớm. Khác bản Python cũ (giết cả nhóm tiến
trình), ở đây lượt gọi model đang bay vẫn chạy nốt.

### Chọn model theo từng bước

Pipeline có 4 lượt gọi. `research.search` và `script` cần suy luận thật;
`research.structure` (ghi chú → JSON) và `metadata` (kịch bản → title/tag) chỉ biến
đổi dữ liệu có sẵn nên hạ model được — đó là ô **"Model bước phụ"** trên UI. Bước
nào chạy model khác mặc định thì event `usage` ghi kèm tên model, và JSON gốc trên
Notion lưu bản đồ trong `meta.usage.stage_models`.

## Output

Mỗi lần chạy tạo một page trong database Notion, không có file nào trên đĩa:

| Phần trên page | Nội dung |
|---|---|
| Properties | Chủ đề, nền tảng, thời lượng mục tiêu/đọc thử, lệch %, model, backend, chi phí, tags, hashtag |
| Kịch bản | Từng section theo timestamp: lời thoại + gợi ý hình ảnh |
| Nghiên cứu | Fact kèm độ tin cậy và nguồn bấm được, góc kể chuyện, hook, điểm bỏ ngỏ |
| Metadata | Các phương án title, description |
| Dữ liệu gốc (JSON) | Toàn bộ brief/research/script/metadata/meta để UI đọc lại chính xác |

## Kiến trúc

```
public/index.html          UI thuần DOM, không build step, poll /api/status mỗi 700ms
        │
src/worker.ts              fetch handler + định tuyến, phục vụ static qua binding ASSETS
        ├─ routes/run.ts       POST /api/run → ctx.waitUntil(runPipeline), /api/status, /api/stop
        ├─ routes/history.ts   /api/runs (query Notion), /api/result (đọc lại 1 run)
        ├─ routes/options.ts   /api/options — nền tảng/model khả dụng theo key đang có
        │
        └─ pipeline.ts         Research → Script → Metadata → Notion
             ├─ agents/research.ts   2 lời gọi: web search → JSON hoá
             ├─ agents/script.ts     1 lời gọi structured output
             ├─ agents/metadata.ts   1 lời gọi structured output
             ├─ llm/runner.ts        pause_turn, retry schema, model theo stage, đếm chi phí
             ├─ llm/{anthropic,openai,gemini,fake}.ts   4 backend, cùng một shape trả về
             ├─ timeline.ts          cộng dồn timestamp, đối chiếu thời lượng
             ├─ notion.ts            ghi page + đọc lại từ khối JSON gốc
             └─ kv-store.ts          trạng thái run + event log trong Workers KV
```

Vài quyết định đáng chú ý:

- **Timestamp do code tính, không do model.** Model chỉ đưa `duration_sec` mỗi
  section; `timeline.ts` cộng dồn và ước lượng thời lượng đọc thật từ số âm tiết
  (2.5 âm tiết/giây cho tiếng Việt), rồi cảnh báo nếu lệch quá 15% so với mục tiêu.
- **Research tách làm hai lời gọi.** Lời gọi có web search trả text (server tool có
  thể `pause_turn` giữa chừng — `llm/runner.ts` nối lượt và gọi tiếp, tối đa 5 lần),
  lời gọi thứ hai ép sang JSON. Tách ra thì rẻ và ổn định hơn gộp một.
- **Structured output + retry.** Mọi stage trả JSON đều gửi kèm JSON Schema strict
  (viết tay trong [src/schemas.ts](src/schemas.ts): inline hết `$ref`, `required` =
  toàn bộ property, `additionalProperties: false`); sai schema thì retry tối đa 2
  lần rồi dừng hẳn, không đoán bừa.
- **Lỗi bên thứ ba chỉ có một câu.** Mọi thất bại khi gọi Anthropic/OpenAI/Gemini/
  Notion đi qua `providerError()`: chi tiết thật ra `console.error` với tiền tố
  `[provider] ` (xem bằng `wrangler tail`), còn người dùng chỉ thấy một câu chung.
- **Trạng thái run nằm trong KV, không phải bộ nhớ tiến trình.** Worker không giữ
  state giữa các request, nên mỗi event (`step`/`usage`/`warning`/`error`) được ghi
  thẳng vào KV — khoảng 10-15 lượt ghi mỗi run, vừa với hạn mức free tier.
- **Gate chất lượng.** Cảnh báo khi >30% fact có độ tin cậy thấp, khi fact thiếu URL
  nguồn, và khi lời thoại vượt ngân sách giây của section.

## Chưa có

B-roll Agent, Outline Agent tách riêng + checkpoint duyệt outline, TTS, dựng video.
Roadmap ở [SPEC.md §6](SPEC.md).
