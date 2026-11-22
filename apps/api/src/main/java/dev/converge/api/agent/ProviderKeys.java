package dev.converge.api.agent;

import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.common.ApiException;

/**
 * A member's own model-provider keys (design §13.5): Anthropic, OpenAI, Google Gemini or OpenRouter, one of
 * each. Stored encrypted; the browser only ever sees a hint such as "…a1b2". The plaintext is decrypted only
 * to hand it to the agent runner for one turn.
 */
@RestController
public class ProviderKeys {

    /** The providers a member can bring a key for, with the prefix their keys start with, if any. */
    public enum Provider {
        ANTHROPIC("Anthropic", "sk-ant-"),
        OPENAI("OpenAI", "sk-"),
        GEMINI("Google Gemini", null),
        OPENROUTER("OpenRouter", "sk-or-");

        final String label;
        final String prefix;

        Provider(String label, String prefix) {
            this.label = label;
            this.prefix = prefix;
        }

        /** As the runner and model names spell it: "openai". */
        public String id() {
            return name().toLowerCase(Locale.ROOT);
        }

        public String label() {
            return label;
        }

        static Provider parse(String raw) {
            return Arrays.stream(values()).filter(p -> p.id().equals(raw)).findFirst()
                    .orElseThrow(() -> ApiException.notFound("Provider"));
        }
    }

    public record KeyStatus(String provider, String label, boolean configured, String hint) {
    }

    public record SetKey(@NotBlank @Size(min = 20, max = 300) String apiKey) {
    }

    private final JdbcClient jdbc;
    private final SecretBox box;
    private final org.springframework.beans.factory.ObjectProvider<AgentTurns> turns;

    public ProviderKeys(JdbcClient jdbc, SecretBox box, org.springframework.beans.factory.ObjectProvider<AgentTurns> turns) {
        this.jdbc = jdbc;
        this.box = box;
        this.turns = turns;
    }

    /** Every provider and whether the member has a key for it. */
    @GetMapping("/api/v1/me/provider-keys")
    List<KeyStatus> all(@AuthenticationPrincipal AppUser user) {
        Map<String, String> hints = jdbc.sql("select provider, key_hint from provider_keys where user_id = ?")
                .param(user.id())
                .query((rs, n) -> Map.entry(rs.getString(1), rs.getString(2)))
                .list().stream().collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
        return Arrays.stream(Provider.values())
                .map(p -> new KeyStatus(p.id(), p.label, hints.containsKey(p.name()), hints.get(p.name())))
                .toList();
    }

    @GetMapping("/api/v1/me/provider-keys/{provider}")
    KeyStatus status(@AuthenticationPrincipal AppUser user, @PathVariable String provider) {
        Provider p = Provider.parse(provider);
        return jdbc.sql("select key_hint from provider_keys where user_id = ? and provider = ?")
                .params(user.id(), p.name())
                .query(String.class)
                .optional()
                .map(hint -> new KeyStatus(p.id(), p.label, true, hint))
                .orElse(new KeyStatus(p.id(), p.label, false, null));
    }

    /** The member's agent spending against the daily cap, for the composer. */
    @GetMapping("/api/v1/me/agent-spend")
    AgentTurns.Spend spend(@AuthenticationPrincipal AppUser user) {
        return turns.getObject().spend(user.id());
    }

    @PutMapping("/api/v1/me/provider-keys/{provider}")
    KeyStatus set(@AuthenticationPrincipal AppUser user, @PathVariable String provider, @Valid @RequestBody SetKey body) {
        Provider p = Provider.parse(provider);
        String key = body.apiKey().strip();
        if (key.chars().anyMatch(Character::isWhitespace)) throw ApiException.badRequest("An API key has no spaces in it");
        if (p.prefix != null && !key.startsWith(p.prefix)) {
            throw ApiException.badRequest("That does not look like an " + p.label + " API key (it starts with " + p.prefix + ")");
        }
        // An Anthropic or OpenRouter key would also pass OpenAI's "sk-" check; saving it there only fails later.
        if (p == Provider.OPENAI && (key.startsWith("sk-ant-") || key.startsWith("sk-or-"))) {
            throw ApiException.badRequest("That looks like a key for " + (key.startsWith("sk-ant-") ? "Anthropic" : "OpenRouter") + ", not OpenAI");
        }
        String hint = "…" + key.substring(key.length() - 4);
        jdbc.sql("""
                insert into provider_keys (user_id, provider, ciphertext, key_hint) values (?, ?, ?, ?)
                on conflict (user_id, provider) do update
                    set ciphertext = excluded.ciphertext, key_hint = excluded.key_hint, created_at = now()
                """)
                .params(user.id(), p.name(), box.seal(key, context(p, user.id())), hint)
                .update();
        return new KeyStatus(p.id(), p.label, true, hint);
    }

    @DeleteMapping("/api/v1/me/provider-keys/{provider}")
    ResponseEntity<Void> delete(@AuthenticationPrincipal AppUser user, @PathVariable String provider) {
        Provider p = Provider.parse(provider);
        jdbc.sql("delete from provider_keys where user_id = ? and provider = ?").params(user.id(), p.name()).update();
        return ResponseEntity.noContent().build();
    }

    /** The decrypted key, for one turn on the runner. */
    Optional<String> reveal(UUID userId, Provider provider) {
        return jdbc.sql("select ciphertext from provider_keys where user_id = ? and provider = ?")
                .params(userId, provider.name())
                .query(byte[].class)
                .optional()
                .map(ciphertext -> box.open(ciphertext, context(provider, userId)));
    }

    /** The providers the member has a key for. */
    List<Provider> configured(UUID userId) {
        List<String> names = jdbc.sql("select provider from provider_keys where user_id = ?").param(userId).query(String.class).list();
        return Arrays.stream(Provider.values()).filter(p -> names.contains(p.name())).toList();
    }

    /** Bound into the ciphertext, so a key cannot be moved to another member or provider. */
    private static String context(Provider provider, UUID userId) {
        return "provider-key:" + provider.name() + ":" + userId;
    }
}
