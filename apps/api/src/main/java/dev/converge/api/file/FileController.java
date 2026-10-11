package dev.converge.api.file;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.file.FileService.Content;
import dev.converge.api.file.FileService.FileNode;
import dev.converge.api.file.FileService.Kind;

@RestController
public class FileController {

    public record CreateFile(@NotNull UUID workspaceId, UUID parentId, @NotNull String name, @NotNull Kind kind) {
    }

    /**
     * Omitted fields keep their value; {@code moveToRoot} moves the item to the top level. Boxed types, because
     * Jackson 3 rejects a missing primitive instead of defaulting it.
     */
    public record MoveFile(String name, UUID parentId, Boolean moveToRoot, @NotNull Integer rowVersion) {
    }

    public record SaveContent(@NotNull String text, Integer baseVersion) {
    }

    private final FileService files;

    public FileController(FileService files) {
        this.files = files;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/tree")
    List<FileNode> tree(@AuthenticationPrincipal AppUser user, @PathVariable UUID workspaceId) {
        return files.tree(workspaceId, user.id());
    }

    @PostMapping("/api/v1/files")
    ResponseEntity<FileNode> create(@AuthenticationPrincipal AppUser user, @Valid @RequestBody CreateFile body) {
        FileNode node = files.create(body.workspaceId(), body.parentId(), body.name(), body.kind(), user.id());
        return ResponseEntity.status(HttpStatus.CREATED).body(node);
    }

    @PatchMapping("/api/v1/files/{id}")
    FileNode move(@AuthenticationPrincipal AppUser user, @PathVariable UUID id, @Valid @RequestBody MoveFile body) {
        return files.move(id, body.name(), body.parentId(), Boolean.TRUE.equals(body.moveToRoot()), body.rowVersion(),
                user.id());
    }

    @DeleteMapping("/api/v1/files/{id}")
    ResponseEntity<Void> delete(@AuthenticationPrincipal AppUser user, @PathVariable UUID id,
            @RequestParam int rowVersion) {
        files.delete(id, rowVersion, user.id());
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/api/v1/files/{id}/content")
    Content content(@AuthenticationPrincipal AppUser user, @PathVariable UUID id) {
        return files.content(id, user.id());
    }

    @PutMapping("/api/v1/files/{id}/content")
    Content save(@AuthenticationPrincipal AppUser user, @PathVariable UUID id, @Valid @RequestBody SaveContent body) {
        return files.save(id, body.text(), body.baseVersion(), user.id());
    }
}
