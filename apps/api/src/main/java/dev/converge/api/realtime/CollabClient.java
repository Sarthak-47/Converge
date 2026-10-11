package dev.converge.api.realtime;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import dev.converge.api.common.ApiException;

/**
 * The API's side of the service boundary (design §5.3): changes that do not come from typing are sent to the
 * collaboration service, which merges them into the live document as edits (design §8.9).
 */
@Component
public class CollabClient {

    private final RestClient client;

    public CollabClient(@Value("${converge.collab.base-url}") String baseUrl,
            @Value("${converge.internal-token:}") String internalToken) {
        HttpClient http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1) // see CollabHealthIndicator: no h2c upgrade header
                .connectTimeout(Duration.ofSeconds(3))
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(http);
        factory.setReadTimeout(Duration.ofSeconds(10));
        this.client = RestClient.builder()
                .baseUrl(baseUrl)
                .requestFactory(factory)
                .defaultHeader(InternalTokenFilter.HEADER, internalToken)
                .build();
    }

    /** Merges {@code text} into the live document as the minimal set of edits, tagged with {@code origin}. */
    public void applyText(UUID fileId, String text, String origin) {
        try {
            client.post().uri("/internal/documents/{id}/apply-text", fileId)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(Map.of("text", text, "origin", origin))
                    .retrieve()
                    .toBodilessEntity();
        } catch (RestClientException e) {
            throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                    "The collaboration service could not apply the change");
        }
    }

    /**
     * Updates a person's open document connections in one workspace: "read-only", "read-write" or "close"
     * (design §5.3, /internal/connections/revoke).
     */
    public void revoke(UUID userId, UUID workspaceId, String action) {
        client.post().uri("/internal/connections/revoke")
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("userId", userId, "workspaceId", workspaceId, "action", action))
                .retrieve()
                .toBodilessEntity();
    }

    /** Disconnects everyone from a deleted file's live document (close code 4404). */
    public void close(UUID fileId) {
        client.post().uri("/internal/documents/{id}/close", fileId).retrieve().toBodilessEntity();
    }

    /** Asks the collaboration service to store pending edits now, so materialized text is current. */
    public void flush(UUID fileId) {
        try {
            client.post().uri("/internal/documents/{id}/flush", fileId).retrieve().toBodilessEntity();
        } catch (RestClientException e) {
            throw new ApiException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE,
                    "The collaboration service could not store the document");
        }
    }
}
