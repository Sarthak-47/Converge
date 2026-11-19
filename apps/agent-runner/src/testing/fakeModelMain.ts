import { FakeModel } from './fakeModel.js'

/** Runs the scripted fake model as a service, for the end-to-end stack (never in production). */
const model = new FakeModel()
const port = Number(process.env.FAKE_MODEL_PORT ?? 9100)
await model.start(port, '0.0.0.0')
console.log(JSON.stringify({ level: 'INFO', service: 'fake-model', event: 'FAKE_MODEL_STARTED', port }))
const stop = () => void model.stop().finally(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
