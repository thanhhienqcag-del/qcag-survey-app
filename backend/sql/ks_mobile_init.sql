-- ============================================================
-- KS Mobile — MySQL schema (chung DB `qcag`, tách biệt QCAG
-- Báo Giá bằng prefix `ks_`). Không có FK sang bảng của Báo
-- Giá để đảm bảo cách ly hoàn toàn; nếu cần join thì dùng
-- query ứng dụng, không dùng constraint cấp DB.
--
-- Tương thích: MySQL 8.0 / Cloud SQL MySQL 8.0
-- Chạy 1 lần duy nhất (IF NOT EXISTS an toàn khi chạy lại).
-- ============================================================

-- ----------------------------------------------------------------
-- 1. Bảng yêu cầu chính (new + warranty)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks_requests (
  id               INT AUTO_INCREMENT PRIMARY KEY,

  -- legacy __backendId từ client (Supabase / local storage)
  -- dùng để map dữ liệu cũ khi migrate
  backend_id       VARCHAR(128)  NULL,

  -- Loại yêu cầu: 'new' (yêu cầu mới) hoặc 'warranty' (bảo hành)
  type             ENUM('new','warranty') NOT NULL DEFAULT 'new',

  -- Thông tin outlet
  outlet_code      VARCHAR(16)   NULL,
  outlet_name      TEXT          NULL,
  address          TEXT          NULL,
  outlet_lat       VARCHAR(32)   NULL,
  outlet_lng       VARCHAR(32)   NULL,
  phone            VARCHAR(32)   NULL,

  -- Nội dung bảng hiệu
  -- items: JSON array [ {id, type, brand, width, height, useOldSize,
  --                      otherContent, poles, action, note, survey} ]
  items            LONGTEXT      NULL,

  -- Nội dung / mô tả yêu cầu
  content          TEXT          NULL,
  old_content      TINYINT(1)    NOT NULL DEFAULT 0,
  old_content_extra TEXT         NULL,

  -- Ảnh (JSON array of GCS public URLs)
  old_content_images  LONGTEXT   NULL,   -- ảnh nội dung cũ
  status_images       LONGTEXT   NULL,   -- ảnh hiện trạng
  design_images       LONGTEXT   NULL,   -- mẫu QC do QCAG upload
  acceptance_images   LONGTEXT   NULL,   -- ảnh nghiệm thu / bảo hành

  -- Bình luận: JSON array [ {authorRole, authorName, text, createdAt} ]
  comments         LONGTEXT      NULL,

  -- Thông tin người tạo (session): JSON
  -- { role, phone, saleCode, saleName, ssCode, ssName, region, isTBA }
  requester        LONGTEXT      NULL,

  -- Trạng thái xử lý
  status           VARCHAR(32)   NOT NULL DEFAULT 'pending',

  -- Cờ workflow: Heineken yêu cầu sửa MQ
  editing_requested_at DATETIME  NULL,

  created_at       DATETIME      DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NULL,

  -- Indexes: tìm theo outlet, type, status, thời gian, và backend_id cũ
  KEY idx_ks_requests_outlet_code (outlet_code(16)),
  KEY idx_ks_requests_type        (type),
  KEY idx_ks_requests_status      (status),
  KEY idx_ks_requests_created_at  (created_at),
  KEY idx_ks_requests_backend_id  (backend_id(64))

) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;


-- ----------------------------------------------------------------
-- 2. Bảng người dùng KS Mobile (QCAG operator)
--    Tách riêng khỏi bảng `users` của Báo Giá để cách ly hoàn toàn.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks_users (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  username         VARCHAR(64)   NOT NULL,  -- số điện thoại hoặc email
  name             VARCHAR(255)  NULL,
  password_hash    VARCHAR(255)  NOT NULL,
  role             ENUM('admin','qcag','heineken') NOT NULL DEFAULT 'qcag',
  approved         TINYINT(1)    NOT NULL DEFAULT 0,
  created_at       DATETIME      DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NULL,
  UNIQUE KEY uq_ks_users_username (username)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;


-- ----------------------------------------------------------------
-- 3. Bảng cấu hình / app settings của KS Mobile
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ks_settings (
  setting_key      VARCHAR(128)  NOT NULL PRIMARY KEY,
  setting_value    LONGTEXT      NULL,
  updated_at       DATETIME      NULL
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- Giá trị mặc định
INSERT INTO ks_settings (setting_key, setting_value, updated_at)
VALUES ('qcag_password', 'qcag123', NOW())
ON DUPLICATE KEY UPDATE updated_at = updated_at;


-- ----------------------------------------------------------------
-- 4. Cấp quyền tối thiểu cho user `qcag_app` trên các bảng KS
--    (chạy sau khi user đã được tạo bởi grant_qcag_app.sql)
-- ----------------------------------------------------------------
-- GRANT SELECT, INSERT, UPDATE ON `qcag`.`ks_requests` TO 'qcag_app'@'%';
-- GRANT SELECT, INSERT, UPDATE ON `qcag`.`ks_users`    TO 'qcag_app'@'%';
-- GRANT SELECT, INSERT, UPDATE ON `qcag`.`ks_settings` TO 'qcag_app'@'%';
-- FLUSH PRIVILEGES;
--
-- (Uncomment và chạy nếu bạn dùng user riêng. Nếu dùng GRANT ALL
--  cho toàn DB `qcag` như grant_qcag_app.sql hiện tại thì không cần.)
