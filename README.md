# Cờ Úp Online

Nền tảng game Cờ Úp 2 người chơi qua mã phòng. Mở bằng Visual Studio Code.

## Cấu trúc

```
co-up-online/
  server.js           # HTTP + WebSocket
  package.json
  public/
    index.html        # giao diện
    css/style.css
    js/game.js        # luật cờ, bàn cờ, đồng hồ
    js/net.js         # tạo/vào phòng
  .vscode/launch.json
```

## Chạy trên VS Code

1. Giải nén thư mục, chọn **File → Open Folder**.
2. Terminal: `npm install`
3. `npm start` hoặc F5 (cấu hình "Chạy Cờ Úp").
4. Mở trình duyệt: http://localhost:8080
5. Người 1: **Tạo phòng** → gửi mã.
6. Người 2: nhập mã → **Vào phòng**.
7. Chủ phòng chọn giờ → **Sẵn sàng**.

Cần Node.js 18+ (https://nodejs.org).
