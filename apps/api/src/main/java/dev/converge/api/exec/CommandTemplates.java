package dev.converge.api.exec;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

import dev.converge.api.common.ApiException;

/**
 * The commands that may run in the sandbox (design §11.5): allowlisted templates, not arbitrary shell. The
 * executor holds its own copy of this list and refuses anything else, so the two must change together.
 *
 * <p>An action is identified by its canonical JSON, {@code {"command":…,"kind":"run_command","workspaceId":…}},
 * whose SHA-256 the approval stores and the executor recomputes before running (design §13.7).
 */
public final class CommandTemplates {

    public record Template(String id, Pattern pattern, String example) {
    }

    public static final List<Template> TEMPLATES = List.of(
            new Template("npm-test", Pattern.compile("^npm test$"), "npm test"),
            new Template("npm-run", Pattern.compile("^npm run [a-z0-9][a-z0-9:_-]{0,39}$"), "npm run lint"),
            new Template("node-test", Pattern.compile("^node --test(?: [A-Za-z0-9_./-]{1,200}){0,10}$"), "node --test"));

    private CommandTemplates() {
    }

    /** Trims and collapses whitespace, so equivalent spellings hash the same. */
    public static String normalize(String command) {
        return command == null ? "" : command.strip().replaceAll("\\s+", " ");
    }

    public static Optional<Template> match(String command) {
        String normalized = normalize(command);
        if (normalized.length() > 500) return Optional.empty();
        return TEMPLATES.stream().filter(t -> t.pattern().matcher(normalized).matches()).findFirst();
    }

    public static String require(String command) {
        String normalized = normalize(command);
        if (match(normalized).isEmpty()) {
            throw ApiException.badRequest("Only allowlisted commands can run in the sandbox: "
                    + String.join(", ", TEMPLATES.stream().map(Template::example).toList())
                    + " (npm run takes a script name; node --test takes test file paths)");
        }
        return normalized;
    }

    /** The canonical action; the executor builds the identical string with JSON.stringify. */
    public static String canonical(UUID workspaceId, String command) {
        // Allowlisted commands contain no characters that JSON escapes, so plain quoting is exact.
        return "{\"command\":\"" + command + "\",\"kind\":\"run_command\",\"workspaceId\":\"" + workspaceId + "\"}";
    }

    public static String hash(String canonical) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
