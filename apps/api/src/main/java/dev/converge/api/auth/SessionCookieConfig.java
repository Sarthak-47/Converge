package dev.converge.api.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;

/**
 * The session cookie Spring Session writes. Spring Boot does not carry {@code server.servlet.session.cookie}
 * over to it, so without this the cookie would be called SESSION and lose HttpOnly and SameSite.
 */
@Configuration
class SessionCookieConfig {

    @Bean
    CookieSerializer sessionCookie(@Value("${server.servlet.session.cookie.name:CONVERGE_SESSION}") String name,
            @Value("${server.servlet.session.cookie.secure:false}") boolean secure) {
        DefaultCookieSerializer cookie = new DefaultCookieSerializer();
        cookie.setCookieName(name);
        cookie.setCookiePath("/");
        cookie.setUseHttpOnlyCookie(true);
        cookie.setSameSite("Lax");
        cookie.setUseSecureCookie(secure);
        return cookie;
    }
}
