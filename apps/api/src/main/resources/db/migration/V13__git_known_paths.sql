-- The paths Converge knows are on the repository's default branch: set by each import to what it brought
-- in, extended by each push with what it wrote. A push deletes on its branch every known path the workspace
-- no longer holds, so deletes, renames and moves reach GitHub, while files Converge never held (binaries,
-- large files, anything added upstream since) are left alone.
alter table git_repositories
    add column known_paths text[] not null default '{}';
