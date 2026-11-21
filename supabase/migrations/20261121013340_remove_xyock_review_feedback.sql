-- Retire the legacy Review feedback storage.
-- The replacement answer-feedback service uses xyock_answer_votes and xyock_answer_reports.
drop table if exists public.xyock_review_feedback;
drop table if exists public.xyock_review_admins;
