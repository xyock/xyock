-- Keep GitHub approval requests and audit records service-role-only.
REVOKE ALL PRIVILEGES ON TABLE
  public.github_action_requests,
  public.github_action_audit
FROM PUBLIC, anon, authenticated;

ALTER TABLE public.github_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.github_action_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny client access" ON public.github_action_requests;
CREATE POLICY "deny client access" ON public.github_action_requests
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "deny client access" ON public.github_action_audit;
CREATE POLICY "deny client access" ON public.github_action_audit
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);
