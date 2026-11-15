-- Keep the synced project-file content limit aligned with the production schema.
-- The previous 300 KB cap was too small for uploaded source files.
alter table public.xyock_project_files
  drop constraint if exists xyock_project_files_content_size;

alter table public.xyock_project_files
  add constraint xyock_project_files_content_size
  check (content is null or octet_length(content) <= 5242880);
