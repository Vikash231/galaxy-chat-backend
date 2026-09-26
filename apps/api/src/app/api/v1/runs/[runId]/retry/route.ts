import { RunParams } from "@gx/contracts";
import { withRoute } from "../../../../../../http/with-route";
import { retryTurn } from "../../../../../../services/turns";

export const POST = withRoute({ params: RunParams }, async ({ user, params, log }) => retryTurn(user, params.runId, log));
