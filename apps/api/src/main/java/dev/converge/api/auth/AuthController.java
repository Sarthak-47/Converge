package dev.converge.api.auth;

import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    public record RegisterRequest(
            @NotBlank @Email @Size(max = 320) String email,
            @NotBlank @Size(max = 80) String displayName,
            @NotBlank @Size(min = 8, max = 128) String password) {
    }

    public record LoginRequest(@NotBlank String email, @NotBlank String password) {
    }

    public record UserView(UUID id, String email, String displayName) {
        static UserView of(AppUser user) {
            return new UserView(user.id(), user.email(), user.displayName());
        }
    }

    private final UserRepository users;
    private final PasswordEncoder passwordEncoder;
    private final AuthenticationManager authenticationManager;
    private final SecurityContextRepository contexts;

    public AuthController(UserRepository users, PasswordEncoder passwordEncoder,
            AuthenticationManager authenticationManager, SecurityContextRepository contexts) {
        this.users = users;
        this.passwordEncoder = passwordEncoder;
        this.authenticationManager = authenticationManager;
        this.contexts = contexts;
    }

    @PostMapping("/register")
    ResponseEntity<UserView> register(@Valid @RequestBody RegisterRequest body, HttpServletRequest request,
            HttpServletResponse response) {
        AppUser user = users.create(body.email(), body.displayName(), passwordEncoder.encode(body.password()));
        signIn(user, request, response);
        return ResponseEntity.status(HttpStatus.CREATED).body(UserView.of(user));
    }

    @PostMapping("/login")
    UserView login(@Valid @RequestBody LoginRequest body, HttpServletRequest request, HttpServletResponse response) {
        Authentication result = authenticationManager.authenticate(
                UsernamePasswordAuthenticationToken.unauthenticated(body.email(), body.password()));
        AppUser user = (AppUser) result.getPrincipal();
        signIn(user, request, response);
        return UserView.of(user);
    }

    @GetMapping("/me")
    UserView me(@AuthenticationPrincipal AppUser user) {
        return UserView.of(user);
    }

    /** Touching the token makes Spring Security issue the XSRF-TOKEN cookie before the first mutating request. */
    @GetMapping("/csrf")
    ResponseEntity<Void> csrf(CsrfToken token) {
        token.getToken();
        return ResponseEntity.noContent().build();
    }

    private void signIn(AppUser user, HttpServletRequest request, HttpServletResponse response) {
        // A fresh session id on sign-in prevents session fixation.
        if (request.getSession(false) != null) {
            request.changeSessionId();
        }
        AppUser principal = user.withoutPassword();
        SecurityContext context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(
                UsernamePasswordAuthenticationToken.authenticated(principal, null, principal.getAuthorities()));
        SecurityContextHolder.setContext(context);
        contexts.saveContext(context, request, response);
    }
}
