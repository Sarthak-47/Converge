package dev.converge.api.file;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import dev.converge.api.common.ApiException;
import dev.converge.api.workspace.Role;
import dev.converge.api.workspace.WorkspaceAccess;

/**
 * The workspace file tree and, until Phase 3 moves live content into Yjs, each file's text.
 * Tree changes use optimistic locking on {@code row_version}; content saves use {@code content_version},
 * so a stale save is rejected with 409 instead of silently overwriting a newer one.
 */
@Service
public class FileService {

    public enum Kind { FILE, FOLDER }

    public record FileNode(UUID id, UUID workspaceId, UUID parentId, String name, Kind kind, String path,
            String language, int rowVersion) {
    }

    public record Content(UUID fileId, String path, String language, String text, int version, String contentHash) {
    }

    /** 1 MB of text: the same limit the desktop sync uses for live files (design §12.7). */
    public static final int MAX_CONTENT_CHARS = 1_000_000;

    private static final String SELECT_NODE =
            "select id, workspace_id, parent_id, name, kind, path, language, row_version from files";

    private final JdbcClient jdbc;
    private final WorkspaceAccess access;

    public FileService(JdbcClient jdbc, WorkspaceAccess access) {
        this.jdbc = jdbc;
        this.access = access;
    }

    public List<FileNode> tree(UUID workspaceId, UUID userId) {
        access.require(workspaceId, userId, Role.VIEWER);
        return jdbc.sql(SELECT_NODE + " where workspace_id = ? and deleted_at is null order by path")
                .param(workspaceId)
                .query(this::toNode)
                .list();
    }

    @Transactional
    public FileNode create(UUID workspaceId, UUID parentId, String rawName, Kind kind, UUID userId) {
        access.require(workspaceId, userId, Role.EDITOR);
        String name = FileNames.validate(rawName);
        String path = name;
        if (parentId != null) {
            FileNode parent = liveNode(parentId);
            if (!parent.workspaceId().equals(workspaceId) || parent.kind() != Kind.FOLDER) {
                throw ApiException.badRequest("The parent must be a folder in the same workspace");
            }
            path = parent.path() + "/" + name;
        }
        UUID id = UUID.randomUUID();
        String language = kind == Kind.FILE ? FileNames.languageFor(name) : null;
        try {
            jdbc.sql("insert into files (id, workspace_id, parent_id, name, kind, path, language) values (?, ?, ?, ?, ?, ?, ?)")
                    .params(id, workspaceId, parentId, name, kind.name(), path, language)
                    .update();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("Something named \"" + name + "\" already exists here");
        }
        if (kind == Kind.FILE) {
            jdbc.sql("insert into documents (file_id, text_content, content_hash) values (?, '', ?)")
                    .params(id, sha256(""))
                    .update();
        }
        return new FileNode(id, workspaceId, parentId, name, kind, path, language, 0);
    }

    /**
     * Renames and/or moves a file or folder. Moving a folder rewrites the paths of everything inside it
     * in the same transaction, so the tree is never observed half-moved.
     */
    @Transactional
    public FileNode move(UUID fileId, String rawName, UUID newParentId, boolean moveToRoot, int rowVersion,
            UUID userId) {
        FileNode node = liveNode(fileId);
        access.require(node.workspaceId(), userId, Role.EDITOR);
        String name = rawName == null ? node.name() : FileNames.validate(rawName);
        UUID parentId = moveToRoot ? null : (newParentId != null ? newParentId : node.parentId());

        String parentPath = null;
        if (parentId != null) {
            FileNode parent = liveNode(parentId);
            if (!parent.workspaceId().equals(node.workspaceId()) || parent.kind() != Kind.FOLDER) {
                throw ApiException.badRequest("The destination must be a folder in the same workspace");
            }
            if (parent.id().equals(node.id()) || parent.path().startsWith(node.path() + "/")) {
                throw ApiException.badRequest("A folder cannot be moved into itself");
            }
            parentPath = parent.path();
        }
        String newPath = parentPath == null ? name : parentPath + "/" + name;
        String language = node.kind() == Kind.FILE ? FileNames.languageFor(name) : null;

        int updated;
        try {
            updated = jdbc.sql("""
                    update files set name = ?, parent_id = ?, path = ?, language = ?,
                           row_version = row_version + 1, updated_at = now()
                    where id = ? and row_version = ? and deleted_at is null
                    """)
                    .params(name, parentId, newPath, language, fileId, rowVersion)
                    .update();
            if (updated == 1 && node.kind() == Kind.FOLDER && !newPath.equals(node.path())) {
                // starts_with avoids LIKE, whose % and _ wildcards could appear in real file names.
                jdbc.sql("""
                        update files set path = ? || substr(path, ?), row_version = row_version + 1, updated_at = now()
                        where workspace_id = ? and deleted_at is null and starts_with(path, ?)
                        """)
                        .params(newPath, node.path().length() + 1, node.workspaceId(), node.path() + "/")
                        .update();
            }
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("Something named \"" + name + "\" already exists there");
        }
        if (updated == 0) {
            throw ApiException.conflict("This item was changed by someone else; refresh and try again");
        }
        return liveNode(fileId);
    }

    /** Soft-deletes a file or a folder and everything inside it (design §8.10). */
    @Transactional
    public void delete(UUID fileId, int rowVersion, UUID userId) {
        FileNode node = liveNode(fileId);
        access.require(node.workspaceId(), userId, Role.EDITOR);
        int updated = jdbc.sql("update files set deleted_at = now() where id = ? and row_version = ? and deleted_at is null")
                .params(fileId, rowVersion)
                .update();
        if (updated == 0) {
            throw ApiException.conflict("This item was changed by someone else; refresh and try again");
        }
        if (node.kind() == Kind.FOLDER) {
            jdbc.sql("update files set deleted_at = now() where workspace_id = ? and deleted_at is null and starts_with(path, ?)")
                    .params(node.workspaceId(), node.path() + "/")
                    .update();
        }
    }

    public Content content(UUID fileId, UUID userId) {
        FileNode node = liveFile(fileId);
        access.require(node.workspaceId(), userId, Role.VIEWER);
        return jdbc.sql("select text_content, content_version, content_hash from documents where file_id = ?")
                .param(fileId)
                .query((rs, n) -> new Content(fileId, node.path(), node.language(), rs.getString("text_content"),
                        rs.getInt("content_version"), rs.getString("content_hash")))
                .single();
    }

    /** Saves new text only if nobody saved since {@code baseVersion}; otherwise 409 (the lost-update guard). */
    @Transactional
    public Content save(UUID fileId, String text, int baseVersion, UUID userId) {
        FileNode node = liveFile(fileId);
        access.require(node.workspaceId(), userId, Role.EDITOR);
        Objects.requireNonNull(text, "text");
        if (text.length() > MAX_CONTENT_CHARS) {
            throw ApiException.badRequest("Files can be at most 1,000,000 characters");
        }
        String hash = sha256(text);
        int updated = jdbc.sql("""
                update documents set text_content = ?, content_hash = ?, content_version = content_version + 1,
                       updated_at = now()
                where file_id = ? and content_version = ?
                """)
                .params(text, hash, fileId, baseVersion)
                .update();
        if (updated == 0) {
            throw ApiException.conflict("This file was saved by someone else since you opened it");
        }
        return new Content(fileId, node.path(), node.language(), text, baseVersion + 1, hash);
    }

    private FileNode liveFile(UUID fileId) {
        FileNode node = liveNode(fileId);
        if (node.kind() != Kind.FILE) {
            throw ApiException.badRequest("Folders have no content");
        }
        return node;
    }

    private FileNode liveNode(UUID fileId) {
        return jdbc.sql(SELECT_NODE + " where id = ? and deleted_at is null")
                .param(fileId)
                .query(this::toNode)
                .optional()
                .orElseThrow(() -> ApiException.notFound("File"));
    }

    private FileNode toNode(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new FileNode(rs.getObject("id", UUID.class), rs.getObject("workspace_id", UUID.class),
                rs.getObject("parent_id", UUID.class), rs.getString("name"), Kind.valueOf(rs.getString("kind")),
                rs.getString("path"), rs.getString("language"), rs.getInt("row_version"));
    }

    static String sha256(String text) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
