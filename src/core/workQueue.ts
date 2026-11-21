/** Collect filesystem bursts by path and run one bounded batch at a time. */
export class WorkspaceWorkQueue {
  private readonly pending = new Set<string>();
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private overflow = false;

  constructor(
    private readonly drain: (paths: string[], signal: AbortSignal, overflow: boolean) => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly debounceMs = 100,
  ) {}

  get busy(): boolean {
    return Boolean(this.timer || this.active);
  }

  add(file: string): void {
    if (this.controller.signal.aborted) return;
    if (this.pending.size < 4096) this.pending.add(file);
    else if (!this.pending.has(file)) this.overflow = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.active || !this.pending.size || this.controller.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const paths = Array.from(this.pending);
      const overflow = this.overflow;
      this.pending.clear();
      this.overflow = false;
      this.active = this.drain(paths, this.controller.signal, overflow).catch((error) => {
        if (!this.controller.signal.aborted) this.report(error);
      }).finally(() => {
        this.active = undefined;
        this.schedule();
      });
    }, this.debounceMs);
  }

  stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    return this.active ?? Promise.resolve();
  }
}

/** Wait for cooperative cleanup up to a fixed deadline. */
export async function drainWithin(work: Promise<unknown>, timeoutMs = 2500): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
