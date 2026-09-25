import { RunParams } from "@gx/contracts";
import { getRunView } from "@gx/db";
import { withRoute } from "../../../../../http/with-route";

export const GET = withRoute({ params: RunParams }, async ({ user, params }) => ({
  data: await getRunView(user.id, params.runId),
}));
