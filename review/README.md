xyock Review
Answer feedback dashboard and reusable widget.
Admin dashboard: https://xyock.github.io/xyock/review/
Reusable widget: https://xyock.github.io/xyock/review/feedback-widget.js
Install widget JS and add <answer-feedback answer-id="unique-id"></answer-feedback> below each AI answer.
Admin login uses xyock email approval and a server-side allowlist. Feedback tables use RLS and deny direct anon/authenticated access.
Backend: supabase/functions/xyock-review/index.ts
Migration: supabase/migrations/20261115072000_create_xyock_review_feedback.sql