import { useState } from 'react';
import { workerSettled, type WorkerReceipt } from './api';
export function WorkerQuestions({
  receipt,
  busy,
  onReply,
}: {
  receipt?: WorkerReceipt;
  busy: boolean;
  onReply: (replyTo: string, text: string) => Promise<unknown>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const pending =
    receipt?.events?.filter(
      (event) =>
        !workerSettled(receipt) &&
        !!receipt?.native?.runId &&
        !!receipt.native.taskId &&
        !!receipt.native.dispatchId &&
        event.type === 'question' &&
        event.questionState === 'pending' &&
        event.runId === receipt.native.runId &&
        event.taskId === receipt.native.taskId &&
        event.dispatchId === receipt.native.dispatchId,
    ) || [];
  return (
    <>
      {pending.map((event) => (
        <form
          className="worker-question"
          key={event.id}
          onSubmit={(e) => {
            e.preventDefault();
            const text = answers[event.id]?.trim();
            if (text) void onReply(event.id, text);
          }}
        >
          <strong>Worker needs an answer: {event.subject || 'Question'}</strong>
          <p>{event.body}</p>
          <label>
            Answer this question
            <textarea
              value={answers[event.id] || ''}
              maxLength={8000}
              onChange={(e) =>
                setAnswers((previous) => ({ ...previous, [event.id]: e.target.value }))
              }
            />
          </label>
          <button disabled={busy || !answers[event.id]?.trim()}>Reply to worker question</button>
          <small>
            Replies to this exact native question; a general follow-up does not resolve it.
          </small>
        </form>
      ))}
    </>
  );
}
