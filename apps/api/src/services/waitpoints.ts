import { AppError, WaitpointRequest, checkAnswer, type AnswerWaitpointResponse, type WaitpointAnswer } from "@gx/contracts";
import { answerWaitpoint, getOwnedWaitpoint, type UserRow } from "@gx/db";
import { withContext, type Logger } from "@gx/observability";
import { completeWaitpointToken } from "./realtime";

/**
 * Record the user's answer, then wake the run. The answer is saved first and the wake-up is repeated on a
 * duplicate submit, so a failed wake-up is fixed by sending the same answer again.
 */
export async function answerWaitpointTurn(user: UserRow, waitpointId: string, answer: WaitpointAnswer, log: Logger): Promise<AnswerWaitpointResponse> {
  const owned = await getOwnedWaitpoint(user.id, waitpointId);
  const problem = checkAnswer(WaitpointRequest.parse(owned.request), answer);
  if (problem) throw new AppError("validation_failed", problem);

  const { result, waitpoint } = await answerWaitpoint(user.id, waitpointId, answer);
  const wlog = withContext({ runId: waitpoint.runId, waitpointTokenId: waitpoint.tokenId ?? undefined }, log);
  wlog.info({ waitpointId, result }, "waitpoint.answer_received");

  // No token yet means the worker has not started waiting; it reads the saved answer when it does.
  if (waitpoint.tokenId) {
    try {
      await completeWaitpointToken(waitpoint.tokenId, { answered: true });
    } catch (err) {
      wlog.error({ err, waitpointId }, "waitpoint.wake_failed");
      throw new AppError("dispatch_failed", "Your answer was saved but the reply could not be resumed. Send the same answer again.");
    }
  }
  return { id: waitpointId, status: "answered" };
}
