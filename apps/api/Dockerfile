FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -q dependency:go-offline
COPY src src
RUN --mount=type=cache,target=/root/.m2 mvn -B -q package -DskipTests

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 converge
WORKDIR /app
COPY --from=build /app/target/converge-api-*.jar app.jar
USER converge
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
