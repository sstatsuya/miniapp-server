# Miniapp Version API

API Node.js tra cứu phiên bản active mới nhất của miniapp từ MongoDB.

## Chạy

Yêu cầu Node.js 18 trở lên.

Đặt các biến sau trong file `.env` ở thư mục gốc của dự án:

```env
MONGO_USERNAME=your_mongodb_username
MONGO_PASSWORD=your_mongodb_password
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

Server kết nối tới database `MiniAppShowcase` trên cluster đã cấu hình trong `server.js`. Hãy thêm IP của máy chạy server vào Network Access trong MongoDB Atlas và đảm bảo user có quyền truy cập database này. `.env` không nên được commit hoặc chia sẻ.

```bash
npm install
npm start
```

Mặc định server chạy tại `http://localhost:3000`. Có thể cấu hình:

- `MONGO_USERNAME`, `MONGO_PASSWORD`: thông tin đăng nhập MongoDB Atlas.
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`: thông tin xác thực Cloudinary.
- `CLOUDINARY_FOLDER`: thư mục lưu bundle trên Cloudinary (mặc định `miniapp-bundles`).

Server chỉ bắt đầu nhận request sau khi kết nối MongoDB thành công.

## API

### Lấy toàn bộ miniapp

`GET /api/miniapp`

```bash
curl "http://localhost:3000/api/miniapp"
```

Trả về mảng tất cả document trong collection `miniapp`, gồm các trường `name`, `createAt` và `data`.
Các miniapp được sắp theo `latestVersion` giảm dần. Bên trong mỗi miniapp, version khớp với `latestVersion` đứng đầu; các version còn lại sắp theo `createAt` mới nhất trước.

### Kích hoạt hoặc tắt phiên bản

`POST /api/miniapp/activate`

Gửi JSON body gồm tên miniapp, phiên bản và trạng thái `isActive`:

```bash
curl -X POST "http://localhost:3000/api/miniapp/activate" \
  -H "Content-Type: application/json" \
  -d '{"name":"MovieTicket","version":"1.0.0","isActive":true}'
```

Khi `isActive` là `true`, phiên bản được chọn sẽ bật, mọi phiên bản khác của miniapp đó sẽ tắt và trường `latestVersion` được cập nhật theo version đó. Khi là `false`, API bật version cao nhất còn lại (nếu có) và cập nhật `latestVersion` theo version đó; nếu không còn version nào, `latestVersion` được đặt thành `null`. API trả về `404` nếu không tìm thấy miniapp hoặc phiên bản.

### Lấy phiên bản active mới nhất

`GET /api/miniapp/get-latest?name=MovieTicket`

Ví dụ dùng `curl`:

```bash
curl "http://localhost:3000/api/miniapp/get-latest?name=MovieTicket"
```

Response `200`:

```json
{
  "name": "MovieTicket",
  "version": "1.0.0",
  "bundleUrl": "https://example.com/miniapp/movie-ticket/1.0.0/index.bundle",
  "createAt": "2026-10-28T13:00:00.000Z",
  "isActive": true
}
```

`name` là query parameter bắt buộc. API trả về `400` nếu thiếu tên và `404` nếu không tìm thấy miniapp hoặc phiên bản active. Model Mongoose được khai báo tại `models/Miniapp.js` và sử dụng collection `miniapp`.

### Upload bundle lên Cloudinary

`POST /api/miniapp/upload` nhận `multipart/form-data` gồm:

- `name`: tên miniapp, chỉ gồm chữ cái, chữ số, `_` hoặc `-`.
- `version`: phiên bản theo định dạng `x.x.x`, ví dụ `1.0.0`.
- `bundle`: file cần upload, phải có phần mở rộng.

File được tải lên Cloudinary dưới dạng raw asset; giới hạn kích thước là 100 MB. Mặc định file được lưu tại `miniapp-bundles/<name>/<name>-<version>.<đuôi-gốc>`.

```bash
curl -X POST "http://localhost:3000/api/miniapp/upload" \
  -F "name=MovieTicket" \
  -F "version=1.0.0" \
  -F "bundle=@./index.bundle"
```

Response `201` trả về `bundleUrl` (URL HTTPS có đuôi file gốc) và `publicId`. Ví dụ public ID: `miniapp-bundles/MovieTicket/MovieTicket-1.0.0.bundle`.
Sau khi upload thành công, phiên bản được thêm vào `data` của miniapp (hoặc cập nhật nếu version đã tồn tại), đặt `isActive: true` và đặt `isActive: false` cho các phiên bản còn lại. Miniapp được tạo trong MongoDB nếu chưa tồn tại.

### Upload TAR bundle với tiến độ Cloudinary

Manager gọi `POST /api/miniapp/upload-v2?uploadId=<UUID>` với các field `name`, `version` và file TAR `bundle`. Endpoint upload trả về `progress: 100` khi hoàn tất.

Trong lúc upload, manager dùng endpoint sau để lấy phần trăm thực tế đang gửi lên Cloudinary:

`GET /api/miniapp/upload-v2/progress/:uploadId`

Response mẫu: `{"progress":42,"status":"uploading"}`. Trạng thái gồm `receiving`, `processing`, `uploading`, `saving`, `complete` và `failed`. Các tiến độ được lưu trong collection `uploadProgress` và tự xóa sau 30 phút.

## Deploy API lên Vercel

Tạo Vercel project với **Root Directory** trỏ tới thư mục `server`. Project dùng `api/index.js` làm Node.js Function và chuyển các request tới Express app.

Cấu hình các environment variables trong Vercel:

- `MONGO_USERNAME`, `MONGO_PASSWORD`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `CORS_ORIGINS`: origin của manager, ví dụ `https://miniapp-manager.vercel.app` (nhiều origin cách nhau bằng dấu phẩy).

Trong manager project, đặt `VITE_API_BASE_URL` thành URL API kèm `/api`, ví dụ `https://miniapp-server.vercel.app/api`, rồi deploy lại manager.

Vercel giới hạn request body tới Function khoảng 4.5 MB. Vì vậy các endpoint upload trên Vercel giới hạn file ở 4 MB để dành chỗ cho multipart headers; TAR lớn hơn cần được upload trực tiếp tới object storage hoặc xử lý trên dịch vụ không có giới hạn body này.

# miniapp-server
