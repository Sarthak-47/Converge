package dev.converge.api.agent;

import java.util.Optional;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.common.ApiException;

/**
 * A member's own Anthropic API key (design §13.5). Stored encrypted; the browser only ever sees a hint such
 * as "…a1b2". The plaintext is decrypted only to hand it to the agent runner for one turn.
 */
@RestController
public class ProviderKeys {

    public record KeyStatus(boolean configured, String hint) {
    }

    public record SetKey(@NotBlank @Size(min = 20, max = 300) String apiKey) {
    }

    static final String PROVIDER = "ANTHROPIC";

    private final JdbcClient jdbc;
    private final SecretBox box;

    public ProviderKeys(JdbcClient jdbc, SecretBox box) {
        this.jdbc = jdbc;
        this.box = box;
    }

    @GetMapping("/api/v1/me/provider-keys/anthropic")
    KeyStatus status(@AuthenticationPrincipal AppUser user) {
        return jdbc.sql("select key_hint from provider_keys where user_id = ? and provider = ?")
                .params(user.id(), PROVIDER)
                .query(String.class)
                .optional()
                .map(hint -> new KeyStatus(true, hint))
                .orElse(new KeyStatus(false, null));
    }

    @PutMapping("/api/v1/me/provider-keys/anthropic")
    KeyStatus set(@AuthenticationPrincipal AppUser user, @Valid @RequestBody SetKey body) {
        String key = body.apiKey().strip();
        if (!key.startsWith("sk-ant-") || key.chars().anyMatch(Character::isWhitespace)) {
            throw ApiException.badRequest("That does not look like an Anthropic API key (it starts with sk-ant-)");
        }
        String hint = "…" + key.substring(key.length() - 4);
        jdbc.sql("""
                insert into provider_keys (user_id, provider, ciphertext, key_hint) values (?, ?, ?, ?)
                on conflict (user_id, provider) do update
                    set ciphertext = excluded.ciphertext, key_hint = excluded.key_hint, created_at = now()
                """)
                .params(user.id(), PROVIDER, box.seal(key, context(user.id())), hint)
                .update();
        return new KeyStatus(true, hint);
    }

    @DeleteMapping("/api/v1/me/provider-keys/anthropic")
    ResponseEntity<Void> delete(@AuthenticationPrincipal AppUser user) {
        jdbc.sql("delete from provider_keys where user_id = ? and provider = ?").params(user.id(), PROVIDER).update();
        return ResponseEntity.noContent().build();
    }

    /** The decrypted key, for one turn on the runner. */
    Optional<String> reveal(UUID userId) {
        return jdbc.sql("select ciphertext from provider_keys where user_id = ? and provider = ?")
                .params(userId, PROVIDER)
                .query(byte[].class)
                .optional()
                .map(ciphertext -> box.open(ciphertext, context(userId)));
    }

    private static String context(UUID userId) {
        return "provider-key:" + PROVIDER + ":" + userId;
    }
}
