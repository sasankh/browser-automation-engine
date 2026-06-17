import { ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import type { SQSClient, Message } from '@aws-sdk/client-sqs';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator';
import { PayloadSchema } from '../intake/payload-schema';
import { parseQueueMessage } from './sqs';
import { logger } from '../shared/logger';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface SqsConsumerDeps {
  sqs: SQSClient;
  queueUrl: string;
  orchestrator: RunOrchestrator;
  maxConcurrentRuns: number;
  visibilityTimeoutSeconds: number;
}

/**
 * Long-polls the run queue and hands each message to the SAME orchestrator as HTTP (ARCHITECTURE §8.3,
 * PROJECT_SPEC §4.2). Prefetches only up to free slots (never more than it can run); extends message
 * visibility on a heartbeat so a long agent run isn't redelivered mid-flight; deletes a message only
 * after the run settles (at-least-once). A message that can't be parsed or keeps crashing is left
 * un-deleted → redelivered → DLQ by the queue's redrive policy.
 */
export class SqsConsumer {
  private running = false;
  private inFlight = 0;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SqsConsumerDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
    logger.info({ queue: this.deps.queueUrl }, 'sqs consumer started');
  }

  async stop(graceMs = 30_000): Promise<void> {
    this.running = false;
    await this.loopDone;
    const start = Date.now();
    while (this.inFlight > 0 && Date.now() - start < graceMs) await sleep(100);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const free = this.deps.maxConcurrentRuns - this.inFlight;
      if (free <= 0) {
        await sleep(200);
        continue;
      }
      let messages: Message[] = [];
      try {
        const res = await this.deps.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.deps.queueUrl,
            MaxNumberOfMessages: Math.min(10, free),
            WaitTimeSeconds: 20,
            VisibilityTimeout: this.deps.visibilityTimeoutSeconds,
          }),
        );
        messages = res.Messages ?? [];
      } catch (err) {
        logger.warn({ err }, 'sqs receive failed');
        await sleep(1_000);
        continue;
      }
      for (const msg of messages) {
        this.inFlight += 1;
        void this.process(msg).finally(() => {
          this.inFlight -= 1;
        });
      }
    }
  }

  private async process(msg: Message): Promise<void> {
    const handle = msg.ReceiptHandle;
    if (!msg.Body || !handle) return;
    const heartbeat = this.startHeartbeat(handle);
    try {
      const { runId, payload } = parseQueueMessage(msg.Body);
      const parsed = PayloadSchema.safeParse(payload);
      if (!parsed.success) {
        // Poison message — leave it for the DLQ (don't ack); never block the queue forever.
        logger.warn({ messageId: msg.MessageId }, 'invalid queue payload; leaving for DLQ');
        return;
      }
      await this.deps.orchestrator.executeFromQueue(runId, parsed.data);
      // Ack only after the run settled (the orchestrator awaits completion).
      await this.deps.sqs.send(new DeleteMessageCommand({ QueueUrl: this.deps.queueUrl, ReceiptHandle: handle }));
    } catch (err) {
      logger.warn({ err, messageId: msg.MessageId }, 'message processing failed — will redeliver');
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Extend visibility periodically while a run is in flight (exceeds the run timeout with margin). */
  private startHeartbeat(handle: string): NodeJS.Timeout {
    const everyMs = Math.max(5_000, (this.deps.visibilityTimeoutSeconds * 1000) / 3);
    const timer = setInterval(() => {
      void this.deps.sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.deps.queueUrl,
            ReceiptHandle: handle,
            VisibilityTimeout: this.deps.visibilityTimeoutSeconds,
          }),
        )
        .catch(() => undefined);
    }, everyMs);
    timer.unref();
    return timer;
  }
}
