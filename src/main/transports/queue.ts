import { TransportRequest } from '@sentry/types';
import { logger, uuid4 } from '@sentry/utils';
import { join } from 'path';

import { readFileAsync, unlinkAsync, writeFileAsync } from '../fs';
import { BufferedWriteStore } from '../store';

const MILLISECONDS_PER_DAY = 86_400_000;

interface PersistedRequest {
  bodyPath: string;
  date: Date;
  // Envelopes were persisted in a different format in v3
  // If this property exists, we discard this event
  type?: unknown;
}

interface PopResult {
  request: QueuedTransportRequest;
  pendingCount: number;
}

export interface QueuedTransportRequest extends TransportRequest {
  date?: Date;
}

/** A request queue that is persisted to disk to survive app restarts */
export class PersistedRequestQueue {
  private readonly _queue: BufferedWriteStore<PersistedRequest[]> = new BufferedWriteStore(
    this._queuePath,
    'queue',
    [],
  );

  public constructor(
    private readonly _queuePath: string,
    private readonly _maxAgeDays: number = 30,
    private readonly _maxCount: number = 30,
  ) {}

  /** Adds a request to the queue */
  public async add(request: QueuedTransportRequest): Promise<number> {
    const bodyPath = uuid4();
    let queuedEvents = 0;

    await this._queue.update((queue) => {
      queue.push({
        bodyPath,
        date: request.date || new Date(),
      });

      while (queue.length > this._maxCount) {
        const removed = queue.shift();
        if (removed) {
          void this._removeBody(removed.bodyPath);
        }
      }

      queuedEvents = queue.length;
      return queue;
    });

    try {
      await writeFileAsync(join(this._queuePath, bodyPath), request.body);
    } catch (_) {
      //
    }

    return queuedEvents;
  }

  /** Pops the oldest event from the queue */
  public async pop(): Promise<PopResult | undefined> {
    let found: PersistedRequest | undefined;
    let pendingCount = 0;
    const cutOff = Date.now() - MILLISECONDS_PER_DAY * this._maxAgeDays;

    await this._queue.update((queue) => {
      while ((found = queue.shift())) {
        // We drop events created in v3 of the SDK or before the cut-off
        if ('type' in found || found.date.getTime() < cutOff) {
          // we're dropping this event so delete the body
          void this._removeBody(found.bodyPath);
          found = undefined;
        } else {
          pendingCount = queue.length;
          break;
        }
      }
      return queue;
    });

    if (found) {
      try {
        const body = await readFileAsync(join(this._queuePath, found.bodyPath));
        void this._removeBody(found.bodyPath);

        return {
          request: {
            body,
            date: found.date || new Date(),
          },
          pendingCount,
        };
      } catch (e) {
        logger.warn('Filed to read queued request body', e);
      }
    }

    return undefined;
  }

  /** Removes the body of the request */
  private async _removeBody(bodyPath: string): Promise<void> {
    try {
      await unlinkAsync(join(this._queuePath, bodyPath));
    } catch (_) {
      //
    }
  }
}
