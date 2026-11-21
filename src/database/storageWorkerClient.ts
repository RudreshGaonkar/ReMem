import { Worker } from 'worker_threads';
import * as path from 'path';

export class StorageWorkerClient {
  private readonly worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private failure?: Error;

  constructor(data: { kind: 'sqlite' | 'vector'; file: string; root?: string }) {
    this.worker = new Worker(path.join(__dirname, 'storage-worker.js'), { workerData: data, stdout: true, stderr: true });
    this.worker.stdout.pipe(process.stderr, { end: false });
    this.worker.stderr.pipe(process.stderr, { end: false });
    this.worker.on('message', ({ id, value, error }) => {
      const job = this.pending.get(id);
      if (!job) return;
      this.pending.delete(id);
      if (error) job.reject(new Error(error));
      else job.resolve(value);
      if (!this.pending.size) this.worker.unref();
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => this.fail(new Error('Storage worker exited with code ' + code)));
    this.worker.unref();
  }

  call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.ref();
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) this.worker.unref();
        reject(error);
      }
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    try {
      await this.worker.terminate();
    } finally {
      this.fail(new Error('Storage worker closed'));
    }
  }
}
