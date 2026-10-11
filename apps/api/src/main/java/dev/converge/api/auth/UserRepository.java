package dev.converge.api.auth;

import java.util.Optional;
import java.util.UUID;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Repository;

import dev.converge.api.common.ApiException;

@Repository
public class UserRepository implements UserDetailsService {

    private final JdbcClient jdbc;

    public UserRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public AppUser create(String email, String displayName, String passwordHash) {
        UUID id = UUID.randomUUID();
        try {
            jdbc.sql("insert into users (id, email, display_name, password_hash) values (?, ?, ?, ?)")
                    .params(id, email.trim(), displayName.trim(), passwordHash)
                    .update();
        } catch (DuplicateKeyException e) {
            throw ApiException.conflict("An account with that email already exists");
        }
        return new AppUser(id, email.trim(), displayName.trim(), passwordHash);
    }

    public Optional<AppUser> findByEmail(String email) {
        return jdbc.sql("select id, email, display_name, password_hash from users where lower(email) = lower(?)")
                .param(email.trim())
                .query((rs, n) -> new AppUser(rs.getObject("id", UUID.class), rs.getString("email"),
                        rs.getString("display_name"), rs.getString("password_hash")))
                .optional();
    }

    @Override
    public AppUser loadUserByUsername(String email) {
        return findByEmail(email).orElseThrow(() -> new UsernameNotFoundException("No such user"));
    }
}
