import { ChatParams, PageQuery, SendMessageBody } from "@gx/contracts";
import { listMessages } from "@gx/db";
import { withRoute } from "../../../../../../http/with-route";
import { sendTurn } from "../../../../../../services/turns";

export const GET = withRoute({ params: ChatParams, query: PageQuery }, async ({ user, params, query }) => ({
  data: await listMessages(user.id, params.chatId, query),
}));

export const POST = withRoute({ params: ChatParams, body: SendMessageBody }, async ({ user, params, body, log }) =>
  sendTurn(user, params.chatId, body, log),
);
