import { CreateChatBody, PageQuery } from "@gx/contracts";
import { createChat, listChats } from "@gx/db";
import { withRoute } from "../../../../http/with-route";

export const POST = withRoute({ body: CreateChatBody }, async ({ user, body }) => ({
  status: 201,
  data: await createChat(user.id, body.title),
}));

export const GET = withRoute({ query: PageQuery }, async ({ user, query }) => ({
  data: await listChats(user.id, query),
}));
