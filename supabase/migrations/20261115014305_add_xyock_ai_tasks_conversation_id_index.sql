-- Index the conversation foreign key used when loading/saving background AI tasks.
CREATE INDEX IF NOT EXISTS xyock_ai_tasks_conversation_id_idx
  ON public.xyock_ai_tasks (conversation_id);
