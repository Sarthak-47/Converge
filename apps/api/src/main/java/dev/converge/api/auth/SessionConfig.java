package dev.converge.api.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.convert.ConversionService;
import org.springframework.core.convert.converter.Converter;
import org.springframework.core.convert.support.GenericConversionService;
import org.springframework.core.serializer.support.DeserializingConverter;
import org.springframework.core.serializer.support.SerializingConverter;
import org.springframework.session.web.http.CookieSerializer;
import org.springframework.session.web.http.DefaultCookieSerializer;

/**
 * How Spring Session's sessions are written: the cookie, and the stored attributes.
 *
 * <p>The session cookie Spring Session writes. Spring Boot does not carry {@code server.servlet.session.cookie}
 * over to it, so without this the cookie would be called SESSION and lose HttpOnly and SameSite.
 */
@Configuration
class SessionConfig {

    private static final Logger log = LoggerFactory.getLogger(SessionConfig.class);

    /**
     * Stored attributes are Java-serialized. After an upgrade that changes a stored class, old sessions no
     * longer deserialize; by default that fails every request carrying such a cookie. Unreadable attributes
     * are read as absent instead, so the person is simply asked to sign in again.
     */
    @Bean("springSessionConversionService")
    ConversionService springSessionConversionService() {
        DeserializingConverter deserializer = new DeserializingConverter(SessionConfig.class.getClassLoader());
        Converter<byte[], Object> tolerant = bytes -> {
            try {
                return deserializer.convert(bytes);
            } catch (RuntimeException e) {
                log.warn("Ignoring a stored session attribute that can no longer be read: {}", e.getMessage());
                return null;
            }
        };
        GenericConversionService conversions = new GenericConversionService();
        conversions.addConverter(Object.class, byte[].class, new SerializingConverter());
        conversions.addConverter(byte[].class, Object.class, tolerant);
        return conversions;
    }

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
