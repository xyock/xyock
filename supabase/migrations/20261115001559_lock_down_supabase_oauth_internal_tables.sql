-- Keep OAuth credentials and PKCE state strictly server-side.
REVOKE ALL PRIVILEGES ON TABLE
  public.supabase_oauth_states,
  public.supabase_oauth_connections
FROM PUBLIC, anon, authenticated;

ALTER TABLE public.supabase_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supabase_oauth_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny client access" ON public.supabase_oauth_states;
CREATE POLICY "deny client access" ON public.supabase_oauth_states
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "deny client access" ON public.supabase_oauth_connections;
CREATE POLICY "deny client access" ON public.supabase_oauth_connections
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);
