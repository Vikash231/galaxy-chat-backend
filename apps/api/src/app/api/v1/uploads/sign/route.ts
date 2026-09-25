import { withRoute } from "../../../../../http/with-route";
import { signUpload } from "../../../../../services/uploads";

export const POST = withRoute({}, async ({ user }) => ({ data: await signUpload(user) }));
