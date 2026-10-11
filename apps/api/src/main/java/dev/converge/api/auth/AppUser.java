package dev.converge.api.auth;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

/** The authenticated principal stored in the session. Workspace roles are checked per request, not here. */
public record AppUser(UUID id, String email, String displayName, String passwordHash) implements UserDetails {

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        return List.of();
    }

    @Override
    public String getPassword() {
        return passwordHash;
    }

    @Override
    public String getUsername() {
        return email;
    }

    /** Copy without the password hash, so the hash is never kept in the session. */
    public AppUser withoutPassword() {
        return new AppUser(id, email, displayName, "");
    }
}
