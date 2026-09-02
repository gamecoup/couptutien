# Đưa Cờ Úp lên internet

Client tự nối `ws://` hoặc `wss://` theo đúng domain đang mở. Trang `https://` bắt buộc WebSocket `wss://`.

## Cách 1 — VPS + Node

```bash
sudo apt update
sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx
git clone <repo> /opt/co-up-online
cd /opt/co-up-online
npm install
PORT=8080 npm start
```

Chạy nền:

```bash
sudo npm i -g pm2
pm2 start server.js --name coup
pm2 save
pm2 startup
```

Nginx (domain `cup.example.com`):

```nginx
server {
  listen 80;
  server_name cup.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

```bash
sudo certbot --nginx -d cup.example.com
```

Mở `https://cup.example.com`.

## Cách 2 — Docker

```bash
docker compose up -d --build
```

Gắn HTTPS bằng Nginx/Caddy phía trước container cổng 8080.

## Dữ liệu

- Tài khoản: `data/accounts.json`. Đăng nhập Google/Facebook (OAuth).
  Redirect Google: `https://DOMAIN/auth/google/callback`
  Redirect Facebook: `https://DOMAIN/auth/facebook/callback`
  Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID`,
  `FACEBOOK_APP_SECRET`, `PUBLIC_URL`. Không đưa secret lên GitHub.
  Trên Render gắn Persistent Disk mount `/data`, biến `DATA_DIR=/data`.
  Không xóa thư mục `data` khi giải nén bản cập nhật.
- Ảnh đại diện: `data/avatars/` (không nhét base64 vào JSON)
- Nhật ký ván: `data/matches.jsonl`

Sao lưu thư mục `data/` định kỳ.

## Lưu ý

- Mở firewall cổng 80/443, không cần public 8080 nếu đã proxy.
- Quên mật khẩu: OTP 6 số, 2 phút, tối đa 3 lần/ngày. Trên Render thêm biến:
  `RESEND_API_KEY` + `MAIL_FROM`
  hoặc `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.
  Không gửi mã OTP ra giao diện.
- Mất mạng giữa ván: server giữ ghế ~90 giây để vào lại.
