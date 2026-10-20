declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown
}

declare var pdfjsWorker:
  | {
      WorkerMessageHandler: typeof import("pdfjs-dist/legacy/build/pdf.worker.mjs").WorkerMessageHandler
    }
  | undefined
