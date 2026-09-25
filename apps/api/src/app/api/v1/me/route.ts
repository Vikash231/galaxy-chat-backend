import { formatCredits } from "@gx/contracts";
import { withRoute } from "../../../../http/with-route";

export const GET = withRoute({}, async ({ user }) => ({
  data: {
    user: { id: user.id, clerkId: user.clerkId },
    credits: { balanceMicro: user.balanceMicro.toString(), formatted: formatCredits(user.balanceMicro) },
  },
}));
