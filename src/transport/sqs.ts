import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Payload } from '../intake/payload-schema';
import type { Envelope } from '../types/envelope';

/**
 * The run-queue message. The body is the same `POST /v1/runs` payload (PROJECT_SPEC §4.2); the `api`
 * transport adds the pre-created `runId` so the caller can poll the exact run the worker executes. A
 * bare payload (no wrapper) is also accepted for direct-to-SQS ingestion (worker creates the run).
 */
export interface QueueMessage {
  runId: string;
  payload: Payload;
}

/** Parse a run-queue message body, tolerating either the `{runId,payload}` wrapper or a bare payload. */
export function parseQueueMessage(body: string): { runId: string | null; payload: Payload } {
  const parsed: unknown = JSON.parse(body);
  if (parsed && typeof parsed === 'object' && 'payload' in parsed) {
    const m = parsed as { runId?: string; payload: Payload };
    return { runId: m.runId ?? null, payload: m.payload };
  }
  return { runId: null, payload: parsed as Payload };
}

export interface JobEnqueuer {
  enqueue(msg: QueueMessage): Promise<void>;
}

export class SqsJobEnqueuer implements JobEnqueuer {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async enqueue(msg: QueueMessage): Promise<void> {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(msg) }));
  }
}

export interface ResultsPublisher {
  publish(envelope: Envelope): Promise<void>;
}

/** Publishes the terminal envelope to `SQS_RESULTS_QUEUE_URL` (optional results fan-out). */
export class SqsResultsPublisher implements ResultsPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(envelope: Envelope): Promise<void> {
    await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(envelope) }));
  }
}

export class NoopResultsPublisher implements ResultsPublisher {
  async publish(): Promise<void> {
    /* no results queue configured */
  }
}
