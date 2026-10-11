package dev.converge.api.file;

import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import dev.converge.api.common.ApiException;

/**
 * File and folder name rules. Names must be valid on every desktop OS, because the desktop app writes them
 * into members' local checkouts (design §12.7), so Windows rules apply even on Linux servers.
 */
public final class FileNames {

    private static final Pattern FORBIDDEN_CHARS = Pattern.compile("[\\\\/:*?\"<>|\\p{Cntrl}]");

    private static final Set<String> WINDOWS_RESERVED = Set.of(
            "con", "prn", "aux", "nul",
            "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
            "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9");

    private static final Map<String, String> LANGUAGES = Map.ofEntries(
            Map.entry("ts", "typescript"), Map.entry("tsx", "typescript"),
            Map.entry("js", "javascript"), Map.entry("jsx", "javascript"), Map.entry("mjs", "javascript"),
            Map.entry("cjs", "javascript"), Map.entry("json", "json"), Map.entry("java", "java"),
            Map.entry("kt", "kotlin"), Map.entry("py", "python"), Map.entry("go", "go"), Map.entry("rs", "rust"),
            Map.entry("c", "c"), Map.entry("h", "c"), Map.entry("cpp", "cpp"), Map.entry("hpp", "cpp"),
            Map.entry("cs", "csharp"), Map.entry("rb", "ruby"), Map.entry("php", "php"),
            Map.entry("html", "html"), Map.entry("css", "css"), Map.entry("scss", "scss"),
            Map.entry("md", "markdown"), Map.entry("yaml", "yaml"), Map.entry("yml", "yaml"),
            Map.entry("xml", "xml"), Map.entry("sql", "sql"), Map.entry("sh", "shell"),
            Map.entry("ps1", "powershell"), Map.entry("dockerfile", "dockerfile"), Map.entry("toml", "ini"));

    private FileNames() {
    }

    public static String validate(String raw) {
        if (raw == null || raw.isBlank()) {
            throw ApiException.badRequest("A name is required");
        }
        String name = raw.strip();
        if (name.length() > 255) {
            throw ApiException.badRequest("Names can be at most 255 characters");
        }
        if (name.equals(".") || name.equals("..")) {
            throw ApiException.badRequest("\"" + name + "\" is not a valid name");
        }
        if (FORBIDDEN_CHARS.matcher(name).find()) {
            throw ApiException.badRequest("Names cannot contain \\ / : * ? \" < > | or control characters");
        }
        if (name.endsWith(".")) {
            throw ApiException.badRequest("Names cannot end with a dot");
        }
        String stem = name.contains(".") ? name.substring(0, name.indexOf('.')) : name;
        if (WINDOWS_RESERVED.contains(stem.toLowerCase(Locale.ROOT))) {
            throw ApiException.badRequest("\"" + stem + "\" is a reserved name on Windows");
        }
        return name;
    }

    /** Monaco language id for a file name, or null to let the editor fall back to plain text. */
    public static String languageFor(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.equals("dockerfile")) {
            return "dockerfile";
        }
        int dot = lower.lastIndexOf('.');
        return dot < 0 ? null : LANGUAGES.get(lower.substring(dot + 1));
    }
}
