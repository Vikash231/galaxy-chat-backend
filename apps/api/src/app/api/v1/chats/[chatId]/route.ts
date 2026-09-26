import { ChatParams, UpdateChatBody } from "@gx/contracts";
import { deleteChat, getChatDetail, updateChat } from "@gx/db";
import { withRoute } from "../../../../../http/with-route";

export const GET = withRoute({ params: ChatParams }, async ({ user, params }) => ({
  data: await getChatDetail(user.id, params.chatId),
}));

export const PATCH = withRoute({ params: ChatParams, body: UpdateChatBody }, async ({ user, params, body }) => ({
  data: await updateChat(user.id, params.chatId, body),
}));

export const DELETE = withRoute({ params: ChatParams }, async ({ user, params }) => ({
  data: await deleteChat(user.id, params.chatId),
}));
