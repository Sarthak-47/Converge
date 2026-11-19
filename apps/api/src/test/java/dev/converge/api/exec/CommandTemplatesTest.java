package dev.converge.api.exec;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * The API's allowlist must accept and refuse exactly what the executor's does; both read the same cases
 * (apps/executor/test/allowlist-cases.json).
 */
class CommandTemplatesTest {

    @Test
    void matchesTheExecutorsAllowlist() throws Exception {
        Map<String, Object> cases = JsonMapper.builder().build().readValue(
                Files.readString(Path.of("..", "executor", "test", "allowlist-cases.json")), new TypeReference<>() {
                });
        @SuppressWarnings("unchecked")
        List<String> allowed = (List<String>) cases.get("allowed");
        @SuppressWarnings("unchecked")
        List<String> refused = (List<String>) cases.get("refused");
        assertThat(allowed).allSatisfy(c -> assertThat(CommandTemplates.match(c)).as(c).isPresent());
        assertThat(refused).allSatisfy(c -> assertThat(CommandTemplates.match(c)).as(c).isEmpty());
    }

    @Test
    void canonicalActionIsTheJsonTheExecutorBuilds() {
        UUID workspace = UUID.fromString("0f8fad5b-d9cb-469f-a165-70867728950e");
        assertThat(CommandTemplates.canonical(workspace, "npm test"))
                .isEqualTo("{\"command\":\"npm test\",\"kind\":\"run_command\",\"workspaceId\":\"0f8fad5b-d9cb-469f-a165-70867728950e\"}");
    }
}
