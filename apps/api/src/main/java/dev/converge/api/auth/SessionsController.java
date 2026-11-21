package dev.converge.api.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.session.FindByIndexNameSessionRepository;
import org.springframework.session.Session;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.common.ApiException;

/**
 * Where a person is signed in, and signing out other devices. Sessions are named by a hash of their id,
 * never the id itself, since the id is what the session cookie carries.
 */
@RestController
@RequestMapping("/api/v1/auth/sessions")
class SessionsController {

    /** The session attribute that describes the device, written at sign-in. */
    static final String DEVICE = "converge.device";

    public record SessionView(String id, String device, Instant signedInAt, Instant lastActiveAt, boolean current) {
    }

    private final ObjectProvider<FindByIndexNameSessionRepository<? extends Session>> repositories;

    SessionsController(ObjectProvider<FindByIndexNameSessionRepository<? extends Session>> repositories) {
        this.repositories = repositories;
    }

    @GetMapping
    List<SessionView> list(@AuthenticationPrincipal AppUser user, HttpServletRequest request) {
        String current = currentId(request);
        return sessionsOf(user).entrySet().stream()
                .map(e -> new SessionView(handle(e.getKey()), device(e.getValue()), e.getValue().getCreationTime(),
                        e.getValue().getLastAccessedTime(), e.getKey().equals(current)))
                .sorted(Comparator.comparing(SessionView::current).reversed()
                        .thenComparing(SessionView::lastActiveAt, Comparator.reverseOrder()))
                .toList();
    }

    @DeleteMapping("/{id}")
    ResponseEntity<Void> signOut(@AuthenticationPrincipal AppUser user, @PathVariable String id, HttpServletRequest request) {
        String current = currentId(request);
        String target = sessionsOf(user).keySet().stream().filter(s -> handle(s).equals(id)).findFirst()
                .orElseThrow(() -> ApiException.notFound("Session"));
        if (target.equals(current)) throw ApiException.badRequest("Use Sign out to sign out of this device");
        repository().deleteById(target);
        return ResponseEntity.noContent().build();
    }

    /** Signs out every device but this one, e.g. after signing in somewhere that should not stay signed in. */
    @PostMapping("/sign-out-others")
    Map<String, Integer> signOutOthers(@AuthenticationPrincipal AppUser user, HttpServletRequest request) {
        String current = currentId(request);
        List<String> others = sessionsOf(user).keySet().stream().filter(s -> !s.equals(current)).toList();
        others.forEach(repository()::deleteById);
        return Map.of("signedOut", others.size());
    }

    private Map<String, ? extends Session> sessionsOf(AppUser user) {
        return repository().findByPrincipalName(user.getUsername());
    }

    private FindByIndexNameSessionRepository<? extends Session> repository() {
        FindByIndexNameSessionRepository<? extends Session> repository = repositories.getIfAvailable();
        if (repository == null) throw ApiException.notFound("Signed-in devices");
        return repository;
    }

    private static String currentId(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        return session == null ? null : session.getId();
    }

    private static String device(Session session) {
        Object device = session.getAttribute(DEVICE);
        return device instanceof String text ? text : "Unknown device";
    }

    static String handle(String sessionId) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(sessionId.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest, 0, 12);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** "Chrome on Windows", "Converge desktop on macOS": enough to recognise a device, nothing more. */
    static String describe(String userAgent) {
        if (userAgent == null || userAgent.isBlank()) return "Unknown device";
        String ua = userAgent;
        String app = ua.contains("Electron/") ? "Converge desktop"
                : ua.contains("Edg/") ? "Edge"
                : ua.contains("OPR/") ? "Opera"
                : ua.contains("Firefox/") ? "Firefox"
                : ua.contains("Chrome/") || ua.contains("CriOS/") ? "Chrome"
                : ua.contains("Safari/") ? "Safari"
                : "A browser";
        String os = ua.contains("iPhone") || ua.contains("iPad") ? "iOS"
                : ua.contains("Android") ? "Android"
                : ua.contains("Windows") ? "Windows"
                : ua.contains("Mac OS X") || ua.contains("Macintosh") ? "macOS"
                : ua.contains("Linux") ? "Linux"
                : null;
        return os == null ? app : app + " on " + os;
    }
}
