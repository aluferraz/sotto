/// <reference lib="webworker" />
import { describeGpu, Lfm } from './lfm'
import { ModelStore, MODEL_BYTES } from './modelStore'
import type { FromWorker, Reply, Request, ToWorker } from './protocol'

/**
 * The engine lives in a worker: compiling the model and each decoding step would otherwise
 * freeze the page, and the worker can use the fast synchronous file access for the download.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope
const send = (message: FromWorker) => scope.postMessage(message)

let store: ModelStore | undefined
let model: Lfm | undefined
let download: AbortController | undefined

/** The model handles one thing at a time, so everything that touches it waits its turn. */
let queue: Promise<unknown> = Promise.resolve()
const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

async function handle(id: number, request: Request): Promise<Reply> {
  const files = store!
  switch (request.type) {
    case 'status':
      return { type: 'status', status: await files.status() }

    case 'download': {
      download?.abort()
      const controller = (download = new AbortController())
      try {
        await files.download((bytes, stage) => send({ id, progress: { bytes, total: MODEL_BYTES, stage } }), controller.signal)
      } finally {
        if (download === controller) download = undefined
      }
      return { type: 'status', status: await files.status() }
    }

    case 'cancelDownload':
      download?.abort()
      return { type: 'done' }

    case 'remove':
      return inTurn(async () => {
        await model?.dispose()
        model = undefined
        await files.remove()
        return { type: 'status', status: await files.status() }
      })

    case 'load':
      return inTurn(async () => {
        const started = performance.now()
        const gpu = await describeGpu()
        if (!gpu.ok) throw new Error(gpu.reason)
        if (!model) {
          send({ id, stage: 'Reading the model' })
          model = await Lfm.create(await files.read(), (stage) => send({ id, stage }))
        }
        return { type: 'loaded', gpu: gpu.name, loadMs: Math.round(performance.now() - started) }
      })

    case 'unload':
      return inTurn(async () => {
        await model?.dispose()
        model = undefined
        return { type: 'done' }
      })

    case 'prepare':
      return inTurn(async () => {
        await model?.prepareCleanup(request.vocabulary)
        return { type: 'done' }
      })

    case 'dictate':
      return inTurn(async () => {
        if (!model) throw new Error('The model is not loaded.')
        const result = await model.dictate(request.samples, request, (partial) => send({ id, partial }))
        return { type: 'result', result }
      })
  }
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const { id, request, base } = event.data
  store ??= new ModelStore(base)
  handle(id, request).then(
    (reply) => send({ id, reply }),
    (error) => send({ id, error: error?.name === 'AbortError' ? 'cancelled' : String(error?.message ?? error) }),
  )
}
