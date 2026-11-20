-- Importing a repository's default branch into the workspace (design §10.2, "pull").
alter table git_operations drop constraint git_operations_type_check;
alter table git_operations add constraint git_operations_type_check check (type in ('PULL_REQUEST', 'PUSH_BRANCH', 'PULL'));
