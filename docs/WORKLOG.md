# Work log

Decisions made while working autonomously, newest last. Each entry says what was decided and why, so it can be reviewed or reversed.

## 2026-10-12 — Rules, repository and CI

- **Project rules recorded** in `CLAUDE.local.md` (gitignored): nothing leaves the project folder; dependency downloads stay in the project; commits only as `Sarthak-47 <0906sarthak@gmail.com>` with no co-author trailers; CI/CD where needed.
- **Dependency caches moved into the project.** npm uses `.cache/npm` (`.npmrc`); Maven uses `apps/api/.m2/repository` (`apps/api/.mvn/maven.config`). Both are gitignored. Downloads made before the rule existed (the global npm cache and `~/.m2`) were left untouched rather than deleted.
- **Docker images and volumes** necessarily live in Docker Desktop's own storage; that is the one exception to "nothing leaves the project folder".
- **Design doc Revision 4** saved only to `docs/` (the copy in Downloads stays at Revision 3, written before the rule).
- **Git identity** set in the repository's local config only; global config untouched.
- **CI (GitHub Actions, `.github/workflows/ci.yml`)**: API tests with Maven on Java 21; npm ci, lint, type-check and build for web and collab; then a Docker Compose smoke test that boots the whole stack and waits for `/api/actuator/health` to report UP. Runs on pushes to `main` and on pull requests.
- **Branching**: commits go straight to `main` while the project is solo; CI guards every push. Pull requests can be introduced when others join.
