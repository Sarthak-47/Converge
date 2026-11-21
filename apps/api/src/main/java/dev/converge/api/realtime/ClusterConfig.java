package dev.converge.api.realtime;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

/** Subscribes this instance to the other instances' realtime events (see {@link ClusterBus}). */
@Configuration
@ConditionalOnProperty(name = "converge.cluster.enabled", havingValue = "true", matchIfMissing = true)
class ClusterConfig {

    @Bean
    RedisMessageListenerContainer realtimeEvents(RedisConnectionFactory redis, ClusterBus bus) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(redis);
        container.addMessageListener(bus, new ChannelTopic(ClusterBus.CHANNEL));
        // A Redis that is down at startup must not stop the API; the container keeps retrying in the background.
        container.setRecoveryInterval(5000L);
        return container;
    }
}
