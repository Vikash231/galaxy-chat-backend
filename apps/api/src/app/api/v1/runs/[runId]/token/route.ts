import { RunParams } from "@gx/contracts";
import { withRoute } from "../../../../../../http/with-route";
import { watchTurn } from "../../../../../../services/turns";

export const POST = withRoute({ params: RunParams }, async ({ user, params, log }) => ({ data: await watchTurn(user, params.runId, log) }));
