# Music Bot (discord.js + Lavalink)

Bot nhạc riêng cho server nhỏ (~10 người). Phát YouTube, link Spotify (tự tìm bản YouTube tương ứng), SoundCloud.

## Cài đặt

1. Tạo bot ở [Discord Developer Portal](https://discord.com/developers/applications), lấy **Token** và **Client ID**. Mời bot vào server với scope `bot` + `applications.commands`, quyền *Connect*, *Speak*, *Send Messages*, *Embed Links*.
2. Tạo app ở [Spotify Developer](https://developer.spotify.com/dashboard), lấy **Client ID/Secret** (miễn phí).
3. `cp .env.example .env` rồi điền các giá trị. **Đổi `LAVALINK_PASSWORD`.**
4. Chạy bằng Docker (khuyên dùng):

```bash
docker compose up -d --build
docker compose logs -f
```

Lần đầu Lavalink tải plugin nên mất khoảng 1 phút. Thấy `[lavalink] node main đã kết nối` là xong.

Chạy không Docker: cần Node 22+, Java 17+ và Lavalink v4 chạy riêng với file `lavalink/application.yml`; sau đó `npm install && npm start`.

## Deploy lên Render

Cần repo GitHub (private) chứa code này, và tài khoản Render có thanh toán (worker và private service không có gói free).

1. Đẩy code lên GitHub (`.env` và `data/` đã nằm trong `.gitignore`).
2. Render Dashboard → **New → Blueprint** → chọn repo; Render đọc `render.yaml` và tạo 2 service: `lavalink` và `music-bot`.
3. Điền các biến `sync: false` khi được hỏi: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, Spotify (nếu dùng). `YT_REFRESH_TOKEN` để trống ở lần đầu.
4. Lavalink bật OAuth YouTube sẵn: xem **Logs** của `lavalink`, làm theo hướng dẫn nhập mã ở `google.com/device` (dùng tài khoản Google phụ), copy refresh token từ log vào `YT_REFRESH_TOKEN`, đặt `YT_OAUTH_SKIP_INIT=true` rồi redeploy.

## YouTube bị chặn trên VPS?

IP datacenter hay bị YouTube yêu cầu đăng nhập. Cách xử lý:

1. Tạo **tài khoản Google phụ** (không dùng tài khoản chính, có rủi ro bị khóa).
2. Đặt `YT_OAUTH_ENABLED=true` trong `.env`, chạy `docker compose up -d`.
3. Xem `docker compose logs lavalink`, làm theo hướng dẫn nhập mã ở `google.com/device`.
4. Log sẽ in ra **refresh token**; dán vào `YT_REFRESH_TOKEN`, đặt `YT_OAUTH_SKIP_INIT=true`, khởi động lại.

Nếu lỗi kéo dài, cập nhật phiên bản `youtube-plugin` trong `lavalink/application.yml` (xem [releases](https://github.com/lavalink-devs/youtube-source/releases)).

## Lệnh

| Lệnh | Chức năng |
|---|---|
| `/play query [source] [next]` | Phát theo tên hoặc link; `next` chèn lên đầu hàng chờ |
| `/skip` `/stop` `/pause` `/resume` | Điều khiển cơ bản |
| `/queue [page]` `/nowplaying` | Xem hàng chờ, bài đang phát (có thanh tiến độ + nút bấm) |
| `/loop off\|track\|queue` `/shuffle` | Lặp và xáo trộn |
| `/volume 1-150` | Âm lượng, được lưu cho server |
| `/seek 1:30` `/remove n` `/clear` | Tua, xóa 1 bài, xóa hàng chờ |
| `/filter` | bassboost, nightcore, vaporwave, 8d, karaoke, tắt |
| `/autoplay` | Hết hàng chờ thì tự phát bài tương tự (YouTube Mix) |
| `/247` | Bot ở lại kênh voice, tự vào lại khi khởi động (cần quyền Manage Server) |
| `/dj [role]` | Chỉ role này (và admin) được điều khiển; bỏ trống = ai cũng được |
| `/settings show\|source\|eq\|tempo\|color\|announce\|reset` | Tùy chỉnh theo server: nguồn tìm mặc định, EQ (flat/bass/treble/vocal/edm/lofi), tốc độ + cao độ (vd slowed), màu embed, bật/tắt tin "Đang phát", xem tất cả, về mặc định |
| `/playlist save\|load\|list\|delete` | Playlist cá nhân, tối đa 25 playlist, 100 bài mỗi playlist |

## Tùy biến nhanh

- Màu embed, trạng thái bot, âm lượng mặc định, thời gian tự rời: sửa trong `.env`.
- Chất lượng mã hóa âm thanh (Opus 0-10, resampling LOW/MEDIUM/HIGH) là cấu hình của Lavalink, không đổi được từ Discord: đặt biến `LAVALINK_OPUS_QUALITY` và `LAVALINK_RESAMPLING` (mặc định 5 / MEDIUM, cao hơn thì hay hơn chút nhưng tốn CPU). Muốn nghe sạch hơn từ Discord: `/settings source YouTube Music`.
- `/filter` và `/settings eq|tempo` dùng chung bộ lọc của player nên ghi đè nhau.
- Thêm lệnh mới: thêm một object vào mảng `commands` trong `src/commands.js`.
- Giao diện "đang phát": hàm `nowEmbed` và `panelRow` trong `src/music.js`.
- Dữ liệu (playlist, cài đặt từng server) nằm ở `data/bot.db` (SQLite), nhớ sao lưu thư mục `data/`.

## Giới hạn đã biết

- Hàng chờ nằm trong RAM: khởi động lại bot hoặc Lavalink là mất hàng chờ (24/7 vẫn tự vào lại kênh).
- Spotify chỉ lấy metadata, âm thanh vẫn từ YouTube, nên chất lượng phụ thuộc bản YouTube tìm được. Playlist do Spotify tự tạo (Daily Mix, Discover Weekly...) thường không nạp được.
- Nếu đặt `GUILD_ID` sau khi từng đăng ký lệnh toàn cầu, lệnh sẽ hiện trùng; xóa lệnh toàn cầu cũ hoặc để trống `GUILD_ID`.
- Dùng YouTube theo cách này vi phạm điều khoản của YouTube; chỉ nên dùng riêng cho nhóm bạn bè.
