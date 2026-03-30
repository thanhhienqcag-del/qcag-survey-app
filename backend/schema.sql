-- =====================================================================
-- QCAG APP - PostgreSQL Schema (Neon)
-- Dùng chung cho Survey App & Quote App
-- =====================================================================

-- Bảng dự án trung tâm - liên kết tất cả dữ liệu
CREATE TABLE IF NOT EXISTS projects (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255)  NOT NULL,
  customer        VARCHAR(255)  NOT NULL,
  outlet_code     VARCHAR(100),
  outlet_name     VARCHAR(255),
  address         TEXT,
  region          VARCHAR(100),
  status          VARCHAR(50)   NOT NULL DEFAULT 'pending',
                  -- pending | ready_for_quote | quoted | in_progress | done | cancelled
  design_image_url TEXT,
  created_by      VARCHAR(255),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Bảng khảo sát - tạo bởi Survey App
CREATE TABLE IF NOT EXISTS surveys (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER       NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  survey_data     JSONB         NOT NULL DEFAULT '{}',
  images          JSONB         NOT NULL DEFAULT '[]', -- mảng Cloudinary URLs
  surveyed_by     VARCHAR(255),
  status          VARCHAR(50)   NOT NULL DEFAULT 'draft',
                  -- draft | submitted | approved
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Bảng báo giá - tạo bởi Quote App
CREATE TABLE IF NOT EXISTS quotes (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER       NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  price           NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(10)   NOT NULL DEFAULT 'VND',
  line_items      JSONB         NOT NULL DEFAULT '[]', -- chi tiết từng hạng mục
  quoted_by       VARCHAR(255),
  status          VARCHAR(50)   NOT NULL DEFAULT 'draft',
                  -- draft | sent | accepted | rejected
  valid_until     DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Bảng đơn hàng - tạo sau khi báo giá được chấp nhận
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER       NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  quote_id        INTEGER       REFERENCES quotes(id),
  status          VARCHAR(50)   NOT NULL DEFAULT 'pending',
                  -- pending | confirmed | in_progress | completed | cancelled
  assigned_to     VARCHAR(255),
  scheduled_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_projects_status     ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_outlet     ON projects(outlet_code);
CREATE INDEX IF NOT EXISTS idx_surveys_project_id  ON surveys(project_id);
CREATE INDEX IF NOT EXISTS idx_quotes_project_id   ON quotes(project_id);
CREATE INDEX IF NOT EXISTS idx_orders_project_id   ON orders(project_id);
CREATE INDEX IF NOT EXISTS idx_orders_status       ON orders(status);

-- ── Auto-update updated_at trigger ───────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_surveys_updated_at
  BEFORE UPDATE ON surveys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
