-- fix-tk-codes.sql
-- Resequence ALL tk_code values in ks_requests to eliminate duplicates.
-- Run this directly in Neon SQL Editor (https://console.neon.tech)
--
-- Logic:
--   - Group rows by year (from created_at)
--   - Within each year, order by (created_at ASC, id ASC)
--   - Assign TK{yy}.{seq:05d}  starting from TK{yy}.00001
--
-- STEP 1: Preview (run this first to verify, no changes made)
-- STEP 2: Apply changes

-- ============================================================
-- STEP 1: PREVIEW — check what will change (read-only)
-- ============================================================
WITH ranked AS (
  SELECT
    id,
    tk_code AS current_code,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY EXTRACT(YEAR FROM created_at)
      ORDER BY created_at ASC, id ASC
    ) AS seq,
    LPAD(CAST(EXTRACT(YEAR FROM created_at) AS TEXT), 4, '0') AS full_year
  FROM ks_requests
),
new_codes AS (
  SELECT
    id,
    current_code,
    'TK' || RIGHT(full_year, 2) || '.' || LPAD(seq::TEXT, 5, '0') AS new_code
  FROM ranked
)
SELECT
  id,
  current_code,
  new_code,
  CASE WHEN current_code = new_code THEN 'OK' ELSE 'WILL CHANGE' END AS status
FROM new_codes
ORDER BY id;


-- ============================================================
-- STEP 2: APPLY FIX (run after verifying STEP 1 looks correct)
-- ============================================================
-- Phase A: Clear all tk_code to NULL first (avoids UNIQUE constraint conflicts)
-- Phase B: Set new sequential codes
-- Phase C: Verify no duplicates remain

-- Phase A: Nullify all
UPDATE ks_requests SET tk_code = NULL;

-- Phase B: Assign new sequential codes
WITH ranked AS (
  SELECT
    id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY EXTRACT(YEAR FROM created_at)
      ORDER BY created_at ASC, id ASC
    ) AS seq,
    RIGHT(LPAD(CAST(EXTRACT(YEAR FROM created_at) AS TEXT), 4, '0'), 2) AS yy
  FROM ks_requests
)
UPDATE ks_requests
SET tk_code = 'TK' || r.yy || '.' || LPAD(r.seq::TEXT, 5, '0')
FROM ranked r
WHERE ks_requests.id = r.id;

-- Phase C: Verify — should return 0 rows if no duplicates remain
SELECT tk_code, COUNT(*) AS cnt
FROM ks_requests
GROUP BY tk_code
HAVING COUNT(*) > 1
ORDER BY tk_code;
