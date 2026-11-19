package dev.converge.api.agent;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import dev.converge.api.common.ApiException;
import dev.converge.api.realtime.InternalTokenFilter;

/** The API's calls to the agent runner (design §5.3): start, cancel and revert turns. */
@Component
public class AgentRunnerClient {

    public record History(String prompt, String reply) {
    }

    public record Sponsor(UUID id, String name) {
    }

    public record StartTurn(UUID turnId, UUID workspaceId, Sponsor sponsor, String apiKey, String model, String effort,
            String prompt, List<History> history, long costCapMicros, SessionContext session) {
    }

    public record SessionContext(UUID id, String task) {
    }

    public record RevertFile(UUID fileId, String state, Object undo) {
    }

    private final RestClient client;

    public AgentRunnerClient(@Value("${converge.agent.runner-url}") String baseUrl,
            @Value("${converge.internal-token:}") String internalToken) {
        HttpClient http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(3))
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(http);
        // A revert opens every file the turn touched, so it gets more time than a start or cancel.
        factory.setReadTimeout(Duration.ofSeconds(60));
        this.client = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(factory)
                .defaultHeader(InternalTokenFilter.HEADER, internalToken)
                .build();
    }

    public void start(StartTurn turn) {
        try {
            client.post().uri("/internal/turns").contentType(MediaType.APPLICATION_JSON).body(turn)
                    .retrieve().toBodilessEntity();
        } catch (RestClientException e) {
            throw unavailable();
        }
    }

    /** Returns false when the runner does not know the turn (for example after a restart). */
    public boolean cancel(UUID turnId) {
        try {
            client.post().uri("/internal/turns/{id}/cancel", turnId).retrieve().toBodilessEntity();
            return true;
        } catch (HttpClientErrorException.NotFound e) {
            return false;
        } catch (RestClientException e) {
            throw unavailable();
        }
    }

    /** Queues guidance for a running turn; false when the runner does not have it. */
    public boolean steer(UUID turnId, String text) {
        try {
            client.post().uri("/internal/turns/{id}/steer", turnId).contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("text", text)).retrieve().toBodilessEntity();
            return true;
        } catch (HttpClientErrorException.NotFound | HttpClientErrorException.Conflict e) {
            return false;
        } catch (RestClientException e) {
            throw unavailable();
        }
    }

    public void revert(UUID turnId, String actorName, List<RevertFile> files) {
        try {
            client.post().uri("/internal/turns/{id}/revert", turnId).contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("actorName", actorName, "files", files))
                    .retrieve().toBodilessEntity();
        } catch (RestClientException e) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "The turn could not be reverted right now");
        }
    }

    private static ApiException unavailable() {
        return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "The agent runner is unavailable");
    }
}
