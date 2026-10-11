package dev.converge.api.realtime;

import java.util.List;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

/**
 * The workspace channel: STOMP over WebSocket at /ws (design §7.1). The handshake is an ordinary HTTP request,
 * so Spring Security authenticates it with the session cookie; browsers cannot forge that cross-site because
 * only same-origin handshakes are accepted unless extra origins are configured.
 */
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final DestinationAuthorizationInterceptor authorization;
    private final List<String> allowedOrigins;

    public WebSocketConfig(DestinationAuthorizationInterceptor authorization,
            @Value("${converge.websocket.allowed-origins:}") List<String> allowedOrigins) {
        this.authorization = authorization;
        this.allowedOrigins = allowedOrigins.stream().filter(o -> !o.isBlank()).toList();
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        var endpoint = registry.addEndpoint("/ws");
        if (!allowedOrigins.isEmpty()) {
            endpoint.setAllowedOriginPatterns(allowedOrigins.toArray(String[]::new));
        }
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        // In-memory broker: enough for one API instance. Multi-instance needs a STOMP broker relay (design §7.5).
        registry.enableSimpleBroker("/topic", "/queue");
        registry.setApplicationDestinationPrefixes("/app");
        registry.setUserDestinationPrefix("/user");
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(authorization);
    }
}
