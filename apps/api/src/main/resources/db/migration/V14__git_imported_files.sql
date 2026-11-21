-- What the last import brought in from the default branch: path -> SHA-256 of the text. The next import
-- deletes, in the workspace, each of these files that has gone from the branch, but only while its text
-- still has this hash; a file edited in Converge since is kept and reported instead.
alter table git_repositories
    add column imported_files jsonb not null default '{}';
