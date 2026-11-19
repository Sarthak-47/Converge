package dev.converge.api.agent;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import dev.converge.api.common.ApiException;

/**
 * Encrypts secrets and transcripts at rest (design §13.5) with AES-256-GCM. The key comes from
 * {@code converge.secrets-key} (base64, 32 bytes); without it, nothing secret can be stored. The associated
 * data binds each ciphertext to its row, so a ciphertext copied to another row does not decrypt.
 */
@Component
public class SecretBox {

    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final SecretKeySpec key;
    private final SecureRandom random = new SecureRandom();

    public SecretBox(@Value("${converge.secrets-key:}") String encodedKey) {
        SecretKeySpec parsed = null;
        if (encodedKey != null && !encodedKey.isBlank()) {
            byte[] raw = Base64.getDecoder().decode(encodedKey.strip());
            if (raw.length != 32) {
                throw new IllegalStateException("converge.secrets-key must be 32 bytes, base64-encoded");
            }
            parsed = new SecretKeySpec(raw, "AES");
        }
        this.key = parsed;
    }

    public boolean configured() {
        return key != null;
    }

    public byte[] seal(String plaintext, String context) {
        requireKey();
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            byte[] sealed = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return ByteBuffer.allocate(NONCE_BYTES + sealed.length).put(nonce).put(sealed).array();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Encryption failed", e);
        }
    }

    public String open(byte[] box, String context) {
        requireKey();
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, box, 0, NONCE_BYTES));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(box, NONCE_BYTES, box.length - NONCE_BYTES), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Decryption failed", e);
        }
    }

    private void requireKey() {
        if (key == null) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Agents are not configured on this server (no secrets key)");
        }
    }
}
