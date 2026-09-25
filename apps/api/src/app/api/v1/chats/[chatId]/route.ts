import { ChatParams } from "@gx/contracts";
import { getChatDetail } from "@gx/db";
import { withRoute } from "../../../../../http/with-route";

export const GET = withRoute({ params: ChatParams }, async ({ user, params }) => ({
  data: await getChatDetail(user.id, params.chatId),
}));
