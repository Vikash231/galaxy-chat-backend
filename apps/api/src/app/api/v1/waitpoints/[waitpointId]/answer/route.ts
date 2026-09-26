import { WaitpointAnswer, WaitpointParams } from "@gx/contracts";
import { withRoute } from "../../../../../../http/with-route";
import { answerWaitpointTurn } from "../../../../../../services/waitpoints";

export const POST = withRoute({ params: WaitpointParams, body: WaitpointAnswer }, async ({ user, params, body, log }) => ({
  data: await answerWaitpointTurn(user, params.waitpointId, body, log),
}));
