import { RunParams } from "@gx/contracts";
import { withRoute } from "../../../../../../http/with-route";
import { stopTurn } from "../../../../../../services/turns";

export const POST = withRoute({ params: RunParams }, async ({ user, params, log }) => ({ data: await stopTurn(user, params.runId, log) }));
