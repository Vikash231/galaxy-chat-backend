import { CompleteUploadBody } from "@gx/contracts";
import { withRoute } from "../../../../../http/with-route";
import { completeUpload } from "../../../../../services/uploads";

export const POST = withRoute({ body: CompleteUploadBody }, async ({ user, body, log }) => ({
  data: { attachments: await completeUpload(user, body.assemblyId, log) },
}));
