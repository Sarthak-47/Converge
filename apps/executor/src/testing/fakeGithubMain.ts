import { FakeGithub } from './fakeGithub.js'

/** Runs the fake GitHub as a service, for the end-to-end stack (never in production). */
const github = new FakeGithub(process.env.FAKE_GITHUB_ROOT ?? '/tmp/fake-github', process.env.FAKE_GITHUB_TOKEN ?? 'ghp_fake_token_for_tests')
const port = Number(process.env.FAKE_GITHUB_PORT ?? 9200)
await github.start(port, '0.0.0.0')
console.log(JSON.stringify({ level: 'INFO', service: 'fake-github', event: 'FAKE_GITHUB_STARTED', port }))
const stop = () => void github.stop().finally(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
