ALTER TABLE public.github_action_requests
  DROP CONSTRAINT IF EXISTS github_action_requests_action_type_check;

ALTER TABLE public.github_action_requests
  ADD CONSTRAINT github_action_requests_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'read_file',
    'create_file',
    'update_file',
    'create_pull_request',
    'deploy_pages',
    'commit_changes'
  ]));
