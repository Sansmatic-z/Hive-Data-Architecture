type JobRequest<TPayload, TResult> = {
  payload: TPayload;
  transfer?: Transferable[];
  resolve: (value: TResult) => void;
  reject: (reason?: unknown) => void;
};

type WorkerRequest<TPayload> = {
  id: number;
  job: TPayload;
};

type WorkerSuccess<TResult> = {
  id: number;
  ok: true;
  result: TResult;
};

type WorkerFailure = {
  id: number;
  ok: false;
  error: string;
};

type WorkerResponse<TResult> = WorkerSuccess<TResult> | WorkerFailure;

export class WorkerPool<TPayload, TResult> {
  private readonly workers: Worker[];
  private readonly queue: Array<JobRequest<TPayload, TResult>> = [];
  private readonly inflight = new Map<number, JobRequest<TPayload, TResult>>();
  private readonly workerToJob = new Map<Worker, number>();
  private readonly idle: Worker[] = [];
  private nextId = 1;
  private terminated = false;

  constructor(size: number, workerFactory: () => Worker) {
    this.workers = Array.from({ length: size }, () => workerFactory());
    this.idle.push(...this.workers);

    for (const worker of this.workers) {
      worker.onmessage = (event: MessageEvent<WorkerResponse<TResult>>) => {
        const data = event.data;
        const request = this.inflight.get(data.id);
        if (!request) {
          return;
        }

        this.inflight.delete(data.id);
        this.workerToJob.delete(worker);
        this.idle.push(worker);
        this.drain();

        if (data.ok) {
          request.resolve(data.result);
        } else {
          request.reject(new Error((data as WorkerFailure).error));
        }
      };

      worker.onerror = (event) => {
        const requestId = this.workerToJob.get(worker);
        if (requestId != null) {
          const request = this.inflight.get(requestId);
          this.inflight.delete(requestId);
          this.workerToJob.delete(worker);
          if (request) {
            request.reject(event.error ?? new Error(event.message));
          }
        }
      };
    }
  }

  run(payload: TPayload, transfer: Transferable[] = []): Promise<TResult> {
    if (this.terminated) {
      return Promise.reject(new Error('Worker pool already terminated.'));
    }

    return new Promise<TResult>((resolve, reject) => {
      this.queue.push({ payload, transfer, resolve, reject });
      this.drain();
    });
  }

  terminate(reason = 'Operation cancelled.'): void {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    for (const worker of this.workers) {
      worker.terminate();
    }

    for (const [, request] of this.inflight) {
      request.reject(new Error(reason));
    }
    this.inflight.clear();

    while (this.queue.length > 0) {
      const request = this.queue.shift();
      request?.reject(new Error(reason));
    }
  }

  private drain(): void {
    while (!this.terminated && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const request = this.queue.shift()!;
      const id = this.nextId++;
      this.inflight.set(id, request);
      this.workerToJob.set(worker, id);
      const message: WorkerRequest<TPayload> = { id, job: request.payload };
      worker.postMessage(message, request.transfer ?? []);
    }
  }
}
