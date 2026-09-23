-- Migration: 059_attendance_working_duration
-- Adds working_minutes and working_seconds integer columns to attendance table
-- to eliminate floating-point precision accumulation drift in working-hour analytics.

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS working_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS working_seconds INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_attendance_working_minutes'
  ) THEN
    ALTER TABLE attendance
      ADD CONSTRAINT chk_attendance_working_minutes
      CHECK (working_minutes >= 0 AND working_minutes <= 1440);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_attendance_working_seconds'
  ) THEN
    ALTER TABLE attendance
      ADD CONSTRAINT chk_attendance_working_seconds
      CHECK (working_seconds >= 0 AND working_seconds <= 86400);
  END IF;
END $$;

-- Backfill existing attendance records to exact whole integer durations
UPDATE attendance
SET
  working_seconds = CASE
    WHEN status IN ('ABSENT', 'LEAVE') THEN 0
    WHEN status = 'HALF_DAY' THEN 14400
    WHEN status = 'PRESENT' AND arrival_time IS NOT NULL THEN
      GREATEST(0, EXTRACT(EPOCH FROM (TIME '17:00:00' - arrival_time))::int)
    WHEN status = 'PRESENT' AND arrival_time IS NULL THEN 28800
    ELSE 0
  END,
  working_minutes = CASE
    WHEN status IN ('ABSENT', 'LEAVE') THEN 0
    WHEN status = 'HALF_DAY' THEN 240
    WHEN status = 'PRESENT' AND arrival_time IS NOT NULL THEN
      FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (TIME '17:00:00' - arrival_time))::int) / 60)::int
    WHEN status = 'PRESENT' AND arrival_time IS NULL THEN 480
    ELSE 0
  END
WHERE working_minutes = 0 AND working_seconds = 0 AND status <> 'ABSENT';

CREATE INDEX IF NOT EXISTS idx_attendance_working_minutes
  ON attendance(user_id, date, working_minutes);
