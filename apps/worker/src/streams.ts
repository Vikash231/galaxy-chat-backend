import { streams } from "@trigger.dev/sdk";
import { ASSISTANT_STREAM_ID, type StreamPart } from "@gx/contracts";

export const assistantStream = streams.define<StreamPart>({ id: ASSISTANT_STREAM_ID });
