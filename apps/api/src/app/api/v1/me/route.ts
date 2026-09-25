import { withRoute } from "../../../../http/with-route";

const formatCredits = (micro: bigint) => (Number(micro) / 1_000_000).toFixed(2);

export const GET = withRoute({}, async ({ user }) => ({
  data: {
    user: { id: user.id, clerkId: user.clerkId },
    credits: { balanceMicro: user.balanceMicro.toString(), formatted: formatCredits(user.balanceMicro) },
  },
}));
